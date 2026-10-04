/* eslint-disable no-useless-assignment -- sequential Devnet ops script */
import { readFileSync, writeFileSync } from "fs";
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
import { randomUUID } from "crypto";

const RPC = "https://solana-devnet.api.onfinality.io/public";
const PROGRAM_ID = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

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
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") {
      return sig;
    }
  }
  throw new Error(`timeout waiting for ${sig}`);
}

async function main() {
  const conn = new Connection(RPC, { commitment: "confirmed", disableRetryOnRateLimit: false });
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync("/tmp/kickr-devnet-payer.json", "utf8"))));
  const programId = new PublicKey(PROGRAM_ID);
  const mint = new PublicKey(MINT);
  const config = deriveConfigPda(programId);
  console.log("payer", payer.publicKey.toBase58());
  await sleep(3000);

  const contestId = randomUUID();
  const contestIdBytes = uuidToBytes(contestId);
  const contestPda = deriveContestPda(programId, contestIdBytes);
  const vault = deriveVaultAddress(mint, contestPda, TOKEN_PROGRAM_ID);
  const fee = 5_000_000;
  const lockAt = Math.floor(Date.now() / 1000) + 45;

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
    const sig = await sendTx(conn, new Transaction().add(ix), [payer]);
    console.log("initialize_contest", sig);
  }
  await sleep(5000);

  const alice = payer;
  const bob = Keypair.generate();
  {
    const sig = await sendTx(
      conn,
      new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: bob.publicKey, lamports: 50_000_000 })),
      [payer],
    );
    console.log("fund bob sol", sig);
  }
  await sleep(5000);
  const aliceAta = getAssociatedTokenAddressSync(mint, alice.publicKey);
  const bobAta = getAssociatedTokenAddressSync(mint, bob.publicKey);
  {
    const ix = createAssociatedTokenAccountInstruction(payer.publicKey, bobAta, bob.publicKey, mint);
    const transfer = createTransferCheckedInstruction(aliceAta, mint, bobAta, alice.publicKey, fee, 6);
    const sig = await sendTx(conn, new Transaction().add(ix, transfer), [payer]);
    console.log("fund bob usdc", sig);
  }
  await sleep(5000);

  async function deposit(user: Keypair, ata: PublicKey) {
    const receipt = deriveDepositReceipt(programId, contestPda, user.publicKey);
    const nonce = randomUUID();
    const team = randomUUID();
    const data = new Uint8Array(8 + 8 + 32 + 16);
    data.set(anchorDiscriminator("deposit"), 0);
    const view = new DataView(data.buffer);
    view.setBigUint64(8, BigInt(fee), true);
    data.set(nonceHash(nonce), 16);
    data.set(uuidToBytes(team), 48);
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

  const depA = await deposit(alice, aliceAta);
  console.log("deposit alice", depA);
  await sleep(5000);
  const depB = await deposit(bob, bobAta);
  console.log("deposit bob", depB);

  const waitMs = Math.max(0, lockAt * 1000 - Date.now()) + 5000;
  console.log("waiting for lock_at ms", waitMs);
  await sleep(waitMs);

  let lockSig = "";
  {
    const data = Buffer.from(anchorDiscriminator("lock_contest"));
    const ix = new TransactionInstruction({
      programId,
      keys: [{ pubkey: contestPda, isSigner: false, isWritable: true }],
      data,
    });
    lockSig = await sendTx(conn, new Transaction().add(ix), [payer]);
    console.log("lock_contest", lockSig);
  }
  await sleep(5000);

  const entryAlice = randomUUID();
  const payout = 9_000_000;
  const feeUnits = 1_000_000;
  const leaf = payoutLeaf(entryAlice, payout, alice.publicKey.toBase58());
  const tree = buildMerkleTree([leaf]);
  const resultHash = fromHex32("11".repeat(32));
  const version = 1;

  let commitSig = "";
  {
    const ix = buildCommitSettlementInstruction({
      programId: PROGRAM_ID,
      initAuthority: payer.publicKey,
      configPda: config,
      contestPda,
      settlementVersion: version,
      resultHash,
      merkleRoot: tree.root,
      totalPayoutBaseUnits: payout,
      feeBaseUnits: feeUnits,
    });
    commitSig = await sendTx(conn, new Transaction().add(ix), [payer]);
    console.log("commit_settlement", commitSig);
    console.log("result_hash", toHex32(resultHash));
    console.log("merkle_root", toHex32(tree.root));
    console.log("settlement_pda", deriveSettlementPda(programId, contestPda, version).toBase58());
  }
  await sleep(5000);

  const vaultBefore = Number((await getAccount(conn, vault)).amount);
  console.log("vault before claim", vaultBefore);

  let claimSig = "";
  {
    const ix = buildClaimPayoutInstruction({
      programId: PROGRAM_ID,
      claimant: alice.publicKey,
      contestPda,
      settlementVersion: version,
      entryId: entryAlice,
      amountBaseUnits: payout,
      proof: tree.proofs[0]!,
      mint,
      vault,
      claimantToken: aliceAta,
      tokenProgramId: TOKEN_PROGRAM_ID,
    });
    claimSig = await sendTx(conn, new Transaction().add(ix), [payer]);
    console.log("claim_payout", claimSig);
  }
  await sleep(5000);

  const vaultAfter = Number((await getAccount(conn, vault)).amount);
  console.log("vault after claim", vaultAfter);

  let secondFailed = false;
  try {
    const ix = buildClaimPayoutInstruction({
      programId: PROGRAM_ID,
      claimant: alice.publicKey,
      contestPda,
      settlementVersion: version,
      entryId: entryAlice,
      amountBaseUnits: payout,
      proof: tree.proofs[0]!,
      mint,
      vault,
      claimantToken: aliceAta,
      tokenProgramId: TOKEN_PROGRAM_ID,
    });
    await sendTx(conn, new Transaction().add(ix), [payer]);
  } catch {
    secondFailed = true;
    console.log("second claim failed as expected");
  }

  writeFileSync("/tmp/kickr-phase6-devnet.json", JSON.stringify({
    contestId,
    entryAlice,
    programId: PROGRAM_ID,
    mint: MINT,
    contestPda: contestPda.toBase58(),
    vault: vault.toBase58(),
    depositAlice: depA,
    depositBob: depB,
    lock: lockSig,
    commit: commitSig,
    claim: claimSig,
    resultHash: toHex32(resultHash),
    merkleRoot: toHex32(tree.root),
    vaultBefore,
    vaultAfter,
    secondClaimFailed: secondFailed,
    upgradeSignature: "2xJUJuja7NVBmvNtxz3YLfJ1rDyJ9g3535wAaiisqASuFzWF7DAX62GcWkquPbdYZemAArfJmV6xhxLsBnpkSdtq",
  }, null, 2));
  console.log("DONE second_claim_failed", secondFailed);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
