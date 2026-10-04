/**
 * Phase 6.1 Devnet: real result hash from local scoring fixture → on-chain commit + claim.
 * Key only from /tmp/kickr-devnet-payer.json. Never prints the secret.
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
  anchorDiscriminator, buildCommitSettlementInstruction, buildClaimPayoutInstruction,
  deriveConfigPda, deriveContestPda, deriveDepositReceipt, deriveVaultAddress, deriveSettlementPda,
  uuidToBytes, nonceHash,
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
    console.error("MISSING_PAYER_KEY", PAYER_PATH);
    process.exit(2);
  }
  const conn = new Connection(RPC, { commitment: "confirmed" });
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER_PATH, "utf8"))));
  console.log("payer", payer.publicKey.toBase58());
  const bal = await conn.getBalance(payer.publicKey);
  console.log("sol_lamports", bal);
  if (bal < 50_000_000) {
    console.error("INSUFFICIENT_SOL");
    process.exit(2);
  }

  // 1) Local real scoring → settlement (result hash NOT all-ones)
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
  console.log("local_fixture_merkle_root", prepared.merkleRoot);
  console.log("local_fixture_settlement_hash", prepared.settlementHash);
  console.log("winner_entry", winner.entryId, "score", winner.finalScoreMilliPoints, "local_payout", winner.netPayoutBaseUnits);

  const programId = new PublicKey(PROGRAM_ID);
  const mint = new PublicKey(MINT);
  const aliceAtaEarly = getAssociatedTokenAddressSync(mint, payer.publicKey);
  let usdcBal = 0n;
  try {
    usdcBal = (await getAccount(conn, aliceAtaEarly)).amount;
  } catch {
    console.error("MISSING_USDC_ATA");
    process.exit(2);
  }
  console.log("usdc_base_units", usdcBal.toString());
  // Scale on-chain entry fee to available Devnet USDC (need 2 deposits). Scores/ranks stay from scoring.
  const fee = Number((usdcBal / 2n));
  if (!Number.isInteger(fee) || fee < 1) {
    console.error("INSUFFICIENT_USDC", { usdc: usdcBal.toString(), needAtLeast: 2 });
    process.exit(2);
  }
  console.log("devnet_entry_fee", fee);

  const feePolicy = {
    id: "dev-fee",
    version: 1,
    rateBps: 1000,
    label: "DEV",
  };
  const payoutPolicy = {
    id: "dev-h2h",
    version: 1,
    policyType: "HEAD_TO_HEAD" as const,
    configuration: { calculation: "winner_takes_prize_pool" as const, tiePolicy: "entry_id_asc" as const },
  };
  const rankedInputs = rows.map((row) => ({
    entryId: row.entryId,
    teamVersionId: row.teamVersionId,
    destinationWallet: payer.publicKey.toBase58(),
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
    contestRules: { scaledForDevnetUsdc: true, localFixtureResultHash: prepared.resultHash },
    entryFeeBaseUnits: fee,
    seatCount: 2,
    feePolicy,
    payoutPolicy,
    computation,
  });
  const resultHashHex = hashResultPayload(payload);
  if (resultHashHex === "1".repeat(64)) {
    throw new Error("refusing all-ones result hash");
  }
  const claimable = computation.rows.filter((row) => row.netPayoutBaseUnits > 0);
  const leaves = claimable.map((row) => payoutLeaf(row.entryId, row.netPayoutBaseUnits, row.destinationWallet));
  const tree = buildMerkleTree(leaves);
  const merkleRoot = tree.root;
  const merkleRootHex = toHex32(merkleRoot);
  const totalPayoutBaseUnits = computation.totalPayoutBaseUnits;
  const feeBaseUnits = computation.feeBaseUnits;
  const settlementHashHex = computeSettlementHash({
    resultHash: resultHashHex,
    merkleRoot: merkleRootHex,
    settlementVersion: prepared.settlementVersion,
    totalPayoutBaseUnits,
    feeBaseUnits,
  });
  const resultHash = fromHex32(resultHashHex);
  const winnerPayout = computation.rows.find((row) => row.entryId === winner.entryId)!;
  console.log("devnet_result_hash", resultHashHex);
  console.log("devnet_merkle_root", merkleRootHex);
  console.log("devnet_settlement_hash", settlementHashHex);
  console.log("devnet_winner_payout", winnerPayout.netPayoutBaseUnits);

  const config = deriveConfigPda(programId);
  const contestId = randomUUID();
  const contestIdBytes = uuidToBytes(contestId);
  const contestPda = deriveContestPda(programId, contestIdBytes);
  const vault = deriveVaultAddress(mint, contestPda, TOKEN_PROGRAM_ID);
  const lockAt = Math.floor(Date.now() / 1000) + 45;

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

  const bob = Keypair.generate();
  await sleep(4000);
  console.log(
    "fund bob sol",
    await sendTx(
      conn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: bob.publicKey, lamports: 50_000_000 })),
      [payer],
    ),
  );
  await sleep(4000);
  const aliceAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const bobAta = getAssociatedTokenAddressSync(mint, bob.publicKey);
  {
    const fundTx = new Transaction();
    try {
      await getAccount(conn, bobAta);
    } catch {
      fundTx.add(createAssociatedTokenAccountInstruction(payer.publicKey, bobAta, bob.publicKey, mint));
    }
    fundTx.add(createTransferCheckedInstruction(aliceAta, mint, bobAta, payer.publicKey, fee, 6));
    console.log("fund bob usdc", await sendTx(conn, fundTx, [payer]));
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
  console.log("deposit alice", await deposit(payer, aliceAta));
  await sleep(4000);
  console.log("deposit bob", await deposit(bob, bobAta));
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
  const commitSig = await sendTx(
    conn,
    new Transaction().add(
      buildCommitSettlementInstruction({
        programId: PROGRAM_ID,
        initAuthority: payer.publicKey,
        configPda: config,
        contestPda,
        settlementVersion: prepared.settlementVersion,
        resultHash,
        merkleRoot,
        totalPayoutBaseUnits,
        feeBaseUnits,
      }),
    ),
    [payer],
  );
  console.log("commit_settlement", commitSig);

  await sleep(4000);
  const vaultBefore = Number((await getAccount(conn, vault)).amount);
  console.log("vault_before", vaultBefore);
  const winnerLeafIndex = claimable.findIndex((row) => row.entryId === winner.entryId);
  if (winnerLeafIndex < 0) throw new Error("winner leaf missing");
  const claimSig = await sendTx(
    conn,
    new Transaction().add(
      buildClaimPayoutInstruction({
        programId: PROGRAM_ID,
        claimant: payer.publicKey,
        contestPda,
        settlementVersion: prepared.settlementVersion,
        entryId: winner.entryId,
        amountBaseUnits: winnerPayout.netPayoutBaseUnits,
        proof: tree.proofs[winnerLeafIndex]!,
        mint,
        vault,
        claimantToken: aliceAta,
        tokenProgramId: TOKEN_PROGRAM_ID,
      }),
    ),
    [payer],
  );
  console.log("claim_payout", claimSig);
  await sleep(4000);
  const vaultAfter = Number((await getAccount(conn, vault)).amount);
  console.log("vault_after", vaultAfter);

  let secondClaimBlockedBeforeSubmit = false;
  let secondClaimFailedSig: string | null = null;
  try {
    secondClaimFailedSig = await sendTx(
      conn,
      new Transaction().add(
        buildClaimPayoutInstruction({
          programId: PROGRAM_ID,
          claimant: payer.publicKey,
          contestPda,
          settlementVersion: prepared.settlementVersion,
          entryId: winner.entryId,
          amountBaseUnits: winnerPayout.netPayoutBaseUnits,
          proof: tree.proofs[winnerLeafIndex]!,
          mint,
          vault,
          claimantToken: aliceAta,
          tokenProgramId: TOKEN_PROGRAM_ID,
        }),
      ),
      [payer],
    );
  } catch (error) {
    const message = String(error);
    if (message.includes("timeout") || message.includes("failed")) {
      // Prefer recording a failed signature if one was broadcast; otherwise note client/simulation block.
      const match = message.match(/([1-9A-HJ-NP-Za-km-z]{64,100})/);
      secondClaimFailedSig = match?.[1] ?? null;
    }
    if (!secondClaimFailedSig) secondClaimBlockedBeforeSubmit = true;
    console.log("second_claim_rejected");
  }

  const out = {
    programId: PROGRAM_ID,
    contestId,
    contestPda: contestPda.toBase58(),
    vault: vault.toBase58(),
    settlementPda: deriveSettlementPda(programId, contestPda, prepared.settlementVersion).toBase58(),
    localFixtureResultHash: prepared.resultHash,
    resultHash: resultHashHex,
    merkleRoot: merkleRootHex,
    settlementHash: settlementHashHex,
    entryFeeBaseUnits: fee,
    commit: commitSig,
    claim: claimSig,
    vaultBefore,
    vaultAfter,
    claimedAmount: winnerPayout.netPayoutBaseUnits,
    feeRetained: vaultAfter,
    winner: {
      entryId: winner.entryId,
      score: winner.finalScoreMilliPoints,
      rank: winner.rank,
      payout: winnerPayout.netPayoutBaseUnits,
      destination: payer.publicKey.toBase58(),
    },
    secondClaimBlockedBeforeSubmit,
    secondClaimFailedSig,
    note: "Devnet entry fee scaled to available USDC; scores/ranks from real Phase 6.1 scoring fixture; destinations remapped to payer for claim.",
  };
  writeFileSync("/tmp/kickr-phase6_1-devnet.json", JSON.stringify(out, null, 2));
  console.log("DONE", JSON.stringify(out, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
