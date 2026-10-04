/**
 * Prepare a fresh Devnet settlement claimable by a specific Phantom wallet.
 * Does NOT submit claim_payout. Does NOT print the payer secret.
 * Destination in merkle leaves = PHANTOM (not payer).
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAccount,
} from "@solana/spl-token";
import {
  anchorDiscriminator, buildCommitSettlementInstruction,
  deriveConfigPda, deriveContestPda, deriveDepositReceipt, deriveVaultAddress, deriveSettlementPda,
  deriveClaimPda, uuidToBytes, nonceHash,
} from "../solana/escrow.ts";
import { buildMerkleTree, payoutLeaf, toHex32, fromHex32 } from "../settlement/merkle.ts";
import { computePayouts } from "../settlement/payouts.ts";
import { buildResultPayload, hashResultPayload } from "../settlement/result-payload.ts";
import { computeSettlementHash } from "../settlement/hash.ts";
import {
  buildPhase61World,
  createAndApproveSnapshots,
  ingestScoringEvents,
  fixtureCtx,
} from "../tests/fixtures/phase6_1_harness.ts";
import { randomUUID } from "crypto";

const RPC = "https://solana-devnet.api.onfinality.io/public";
const PROGRAM_ID = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYER_PATH = "/tmp/kickr-devnet-payer.json";
const PHANTOM = "GjJYQen9kw4K3ETpeKCTbxvmfzDSYPJoG2Wy3kC9Je5S";
const OUT = "/tmp/kickr-phantom-claimable-devnet.json";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTx(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  const latest = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = signers[0]!.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(`tx failed ${sig}: ${JSON.stringify(v.err)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`timeout ${sig}`);
}

async function main() {
  if (!existsSync(PAYER_PATH)) {
    console.error("MISSING_PAYER_KEY");
    process.exit(2);
  }
  const phantomPk = new PublicKey(PHANTOM);
  const conn = new Connection(RPC, { commitment: "confirmed" });
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER_PATH, "utf8"))));
  console.log("payer", payer.publicKey.toBase58());
  console.log("phantom_destination", PHANTOM);

  const payerSol = await conn.getBalance(payer.publicKey);
  const phantomSolBefore = await conn.getBalance(phantomPk);
  console.log("payer_sol_lamports", payerSol);
  console.log("phantom_sol_lamports_before", phantomSolBefore);
  if (payerSol < 100_000_000) {
    console.error("INSUFFICIENT_SOL", { payerSol });
    process.exit(2);
  }

  const mint = new PublicKey(MINT);
  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  let usdcBal = 0n;
  try {
    usdcBal = (await getAccount(conn, payerAta)).amount;
  } catch {
    console.error("MISSING_USDC_ATA");
    process.exit(2);
  }
  console.log("payer_usdc_base_units", usdcBal.toString());
  const fee = Number(usdcBal / 2n);
  if (!Number.isInteger(fee) || fee < 1) {
    console.error("INSUFFICIENT_USDC", { usdc: usdcBal.toString(), needAtLeast: 2 });
    process.exit(2);
  }
  console.log("devnet_entry_fee", fee);

  // Real scoring path
  const world = await buildPhase61World({
    contestType: "HEAD_TO_HEAD",
    entrantCount: 2,
    clearCatalogEvents: true,
  });
  await ingestScoringEvents(world, "default");
  await createAndApproveSnapshots(world);
  const settlement = await world.orchestrator.calculateFromApprovedSnapshots({
    contestId: world.contest.id,
    matchSettlementGate: "FINAL",
    actorId: "devnet",
    nowIso: fixtureCtx().now.toISOString(),
  });
  await world.settlements.review(settlement.id, "devnet", fixtureCtx().now.toISOString());
  await world.settlements.approve(settlement.id, "devnet", fixtureCtx().now.toISOString());
  const prepared = await world.orchestrator.prepareIfReady(settlement.id, fixtureCtx().now.toISOString());
  const rows = await world.settlements.getLeaderboard(prepared.id);
  const winner = rows.find((row) => row.rank === 1)!;
  if (prepared.resultHash === "1".repeat(64)) {
    throw new Error("refusing all-ones result hash");
  }
  console.log("local_fixture_result_hash", prepared.resultHash);
  console.log("winner_entry", winner.entryId, "score", winner.finalScoreMilliPoints, "rank", winner.rank);

  // Remap ALL claimable destinations to Phantom so the leaf claimant is Phantom.
  // Scores/ranks/entry ids stay from scoring; amounts scaled to available USDC.
  const feePolicy = { id: "dev-fee", version: 1, rateBps: 1000, label: "DEV" };
  const payoutPolicy = {
    id: "dev-h2h",
    version: 1,
    policyType: "HEAD_TO_HEAD" as const,
    configuration: { calculation: "winner_takes_prize_pool" as const, tiePolicy: "entry_id_asc" as const },
  };
  const rankedInputs = rows.map((row) => ({
    entryId: row.entryId,
    teamVersionId: row.teamVersionId,
    destinationWallet: PHANTOM,
    baseScoreMilliPoints: row.baseScoreMilliPoints,
    finalScoreMilliPoints: row.finalScoreMilliPoints,
    xi: row.xi,
    captainId: row.captainId,
    viceId: row.viceId,
  }));
  const computation = computePayouts({
    entries: rankedInputs,
    entryFeeBaseUnits: fee,
    feePolicy,
    payoutPolicy,
  });
  const payload = buildResultPayload({
    contestId: world.contest.id,
    matchId: world.contest.matchId,
    settlementVersion: prepared.settlementVersion,
    calculationVersion: prepared.calculationVersion ?? 1,
    rulesetName: "DEV_V1",
    rulesetVersion: 1,
    contestRules: {
      scaledForDevnetUsdc: true,
      phantomClaimable: true,
      localFixtureResultHash: prepared.resultHash,
      destination: PHANTOM,
    },
    entryFeeBaseUnits: fee,
    seatCount: 2,
    feePolicy,
    payoutPolicy,
    computation,
  });
  const resultHashHex = hashResultPayload(payload);
  if (resultHashHex === "1".repeat(64)) throw new Error("refusing all-ones result hash");
  const claimable = computation.rows.filter((row) => row.netPayoutBaseUnits > 0);
  if (claimable.length === 0) throw new Error("no claimable rows");
  for (const row of claimable) {
    if (row.destinationWallet !== PHANTOM) throw new Error("destination must be Phantom");
  }
  const leaves = claimable.map((row) => payoutLeaf(row.entryId, row.netPayoutBaseUnits, row.destinationWallet));
  const tree = buildMerkleTree(leaves);
  const merkleRootHex = toHex32(tree.root);
  const totalPayoutBaseUnits = computation.totalPayoutBaseUnits;
  const feeBaseUnits = computation.feeBaseUnits;
  const settlementHashHex = computeSettlementHash({
    resultHash: resultHashHex,
    merkleRoot: merkleRootHex,
    settlementVersion: prepared.settlementVersion,
    totalPayoutBaseUnits,
    feeBaseUnits,
  });
  const winnerPayout = computation.rows.find((row) => row.entryId === winner.entryId)!;
  const winnerLeafIndex = claimable.findIndex((row) => row.entryId === winner.entryId);
  if (winnerLeafIndex < 0) throw new Error("winner leaf missing");
  const proofHex = tree.proofs[winnerLeafIndex]!.map(toHex32);

  console.log("devnet_result_hash", resultHashHex);
  console.log("devnet_merkle_root", merkleRootHex);
  console.log("devnet_winner_payout", winnerPayout.netPayoutBaseUnits);
  console.log("devnet_destination", winnerPayout.destinationWallet);

  const programId = new PublicKey(PROGRAM_ID);
  const config = deriveConfigPda(programId);
  const contestId = randomUUID();
  const contestIdBytes = uuidToBytes(contestId);
  const contestPda = deriveContestPda(programId, contestIdBytes);
  const vault = deriveVaultAddress(mint, contestPda, TOKEN_PROGRAM_ID);
  const settlementPda = deriveSettlementPda(programId, contestPda, prepared.settlementVersion);
  const claimPda = deriveClaimPda(programId, contestPda, prepared.settlementVersion, uuidToBytes(winner.entryId));
  const phantomAta = getAssociatedTokenAddressSync(mint, phantomPk);
  const lockAt = Math.floor(Date.now() / 1000) + 50;

  await sleep(3000);
  {
    const data = new Uint8Array(8 + 16 + 8 + 4 + 8);
    data.set(anchorDiscriminator("initialize_contest"), 0);
    data.set(contestIdBytes, 8);
    const view = new DataView(data.buffer);
    view.setBigUint64(24, BigInt(fee), true);
    view.setUint32(32, 2, true);
    view.setBigInt64(36, BigInt(lockAt), true);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: payer.publicKey, isSigner: true, isWritable: true },
        { pubkey: config, isSigner: false, isWritable: false },
        { pubkey: contestPda, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    });
    console.log("initialize_contest", await sendTx(conn, new Transaction().add(ix), [payer]));
  }

  // Fund Phantom with ~0.05 SOL for claim fees
  await sleep(4000);
  console.log(
    "fund_phantom_sol",
    await sendTx(
      conn,
      new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: payer.publicKey,
          toPubkey: phantomPk,
          lamports: 50_000_000,
        }),
      ),
      [payer],
    ),
  );

  // Create Phantom USDC ATA (claim_payout requires existing ATA; program does not init_if_needed)
  await sleep(4000);
  {
    const fundTx = new Transaction();
    try {
      await getAccount(conn, phantomAta);
      console.log("phantom_usdc_ata_exists", phantomAta.toBase58());
    } catch {
      fundTx.add(createAssociatedTokenAccountInstruction(payer.publicKey, phantomAta, phantomPk, mint));
      console.log("create_phantom_ata", await sendTx(conn, fundTx, [payer]));
    }
  }

  const bob = Keypair.generate();
  await sleep(4000);
  console.log(
    "fund_bob_sol",
    await sendTx(
      conn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: bob.publicKey, lamports: 50_000_000 })),
      [payer],
    ),
  );
  await sleep(4000);
  const bobAta = getAssociatedTokenAddressSync(mint, bob.publicKey);
  {
    const fundTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(payer.publicKey, bobAta, bob.publicKey, mint),
      createTransferCheckedInstruction(payerAta, mint, bobAta, payer.publicKey, fee, 6),
    );
    console.log("fund_bob_usdc", await sendTx(conn, fundTx, [payer]));
  }

  async function deposit(user: Keypair, ata: PublicKey) {
    const receipt = deriveDepositReceipt(programId, contestPda, user.publicKey);
    const data = new Uint8Array(8 + 8 + 32 + 16);
    data.set(anchorDiscriminator("deposit"), 0);
    const view = new DataView(data.buffer);
    view.setBigUint64(8, BigInt(fee), true);
    data.set(nonceHash(randomUUID()), 16);
    data.set(uuidToBytes(randomUUID()), 48);
    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: user.publicKey, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: contestPda, isSigner: false, isWritable: true },
        { pubkey: vault, isSigner: false, isWritable: true },
        { pubkey: receipt, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: Buffer.from(data),
    });
    const signers = user.publicKey.equals(payer.publicKey) ? [payer] : [payer, user];
    return sendTx(conn, new Transaction().add(ix), signers);
  }

  await sleep(4000);
  console.log("deposit_alice", await deposit(payer, payerAta));
  await sleep(4000);
  console.log("deposit_bob", await deposit(bob, bobAta));
  await sleep(Math.max(0, lockAt * 1000 - Date.now()) + 5000);
  console.log(
    "lock",
    await sendTx(
      conn,
      new Transaction().add(
        new TransactionInstruction({
          programId,
          keys: [{ pubkey: contestPda, isSigner: false, isWritable: true }],
          data: Buffer.from(anchorDiscriminator("lock_contest")),
        }),
      ),
      [payer],
    ),
  );

  await sleep(4000);
  const vaultBefore = Number((await getAccount(conn, vault)).amount);
  console.log("vault_before", vaultBefore);
  const commitSig = await sendTx(
    conn,
    new Transaction().add(
      buildCommitSettlementInstruction({
        programId: PROGRAM_ID,
        initAuthority: payer.publicKey,
        configPda: config,
        contestPda,
        settlementVersion: prepared.settlementVersion,
        resultHash: fromHex32(resultHashHex),
        merkleRoot: tree.root,
        totalPayoutBaseUnits,
        feeBaseUnits,
      }),
    ),
    [payer],
  );
  console.log("commit_settlement", commitSig);

  const phantomSolAfter = await conn.getBalance(phantomPk);
  console.log("phantom_sol_lamports_after", phantomSolAfter);

  const out = {
    note: "Prepared for Phantom claim_payout. claim_payout NOT submitted. Do not treat as claimed.",
    programId: PROGRAM_ID,
    rpc: RPC,
    mint: MINT,
    cluster: "devnet",
    localFixtureContestId: world.contest.id,
    localFixtureSettlementId: prepared.id,
    onChainContestId: contestId,
    contestPda: contestPda.toBase58(),
    vault: vault.toBase58(),
    settlementPda: settlementPda.toBase58(),
    claimPda: claimPda.toBase58(),
    settlementVersion: prepared.settlementVersion,
    resultHash: resultHashHex,
    merkleRoot: merkleRootHex,
    settlementHash: settlementHashHex,
    settlementSignature: commitSig,
    vaultBefore,
    feeBaseUnits,
    totalPayoutBaseUnits,
    entryFeeBaseUnits: fee,
    winner: {
      entryId: winner.entryId,
      teamVersionId: winner.teamVersionId,
      scoreMilliPoints: winner.finalScoreMilliPoints,
      rank: winner.rank,
      payoutBaseUnits: winnerPayout.netPayoutBaseUnits,
      destination: PHANTOM,
      proof: proofHex,
      claimantTokenAta: phantomAta.toBase58(),
    },
    phantomSolLamportsAfter: phantomSolAfter,
    claimSubmitted: false,
    claimConfirmed: false,
    ui: {
      canShowClaimPrize: false,
      reason:
        "Running API uses InMemorySettlementStore; this on-chain settlement is not loaded into process memory. Contests/entries for Phantom are not confirmed in Postgres for this on-chain contest UUID. User must Sign in with Phantom (GjJYQ…) — Claim Prize appears on #/matches/<matchId>/contests only after my-result returns claimable for that wallet's confirmed entry. Use this claim pack with a wallet adapter / claim_payout builder directly, or wire settlement into the API session after Phantom login.",
      kickrUrlHint: "http://localhost:3000/ (or the app origin serving Vite) → Sign in with Phantom wallet GjJYQen9kw4K3ETpeKCTbxvmfzDSYPJoG2Wy3kC9Je5S → open the match contests page once a matching confirmed entry + SETTLEMENT_CONFIRMED exist in the running API",
      account: PHANTOM,
    },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log("WROTE", OUT);
  console.log("DONE_NO_CLAIM");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
