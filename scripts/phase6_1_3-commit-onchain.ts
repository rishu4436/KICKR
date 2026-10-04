/**
 * Phase 6.1.3: fund vault + commit_settlement for an existing Postgres-prepared settlement.
 * Uses the SAME contest UUID / result hash / merkle root / payout / fee from the app settlement.
 * Does NOT submit claim_payout. Does NOT print payer secret.
 *
 * Usage: node --env-file=.env ./node_modules/tsx/dist/cli.mjs scripts/phase6_1_3-commit-onchain.ts
 */
import { readFileSync, writeFileSync, existsSync } from "fs";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAccount,
} from "@solana/spl-token";
import { randomUUID } from "crypto";
import {
  anchorDiscriminator, buildCommitSettlementInstruction,
  deriveConfigPda, deriveContestPda, deriveDepositReceipt, deriveVaultAddress, deriveSettlementPda,
  uuidToBytes, nonceHash,
} from "../solana/escrow.ts";
import { fromHex32 } from "../settlement/merkle.ts";
import { loadConfig } from "../config/load.ts";
import { asQueryable, createPool } from "../db/pool.ts";
import { createPgSettlementStore } from "../db/settlement-repository.ts";
import { SettlementService } from "../settlement/service.ts";

const RPC = "https://solana-devnet.api.onfinality.io/public";
const PROGRAM_ID = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const PAYER_PATH = "/tmp/kickr-devnet-payer.json";
const PHANTOM = "GjJYQen9kw4K3ETpeKCTbxvmfzDSYPJoG2Wy3kC9Je5S";
const FIXTURE = "/tmp/kickr-phase6_1_3-fixture.json";
const OUT = "/tmp/kickr-phase6_1_3-fixture.json";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function getClusterClock(conn: Connection): Promise<number> {
  const clockInfo = await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"));
  if (!clockInfo) throw new Error("clock sysvar missing");
  return Number(new DataView(clockInfo.data.buffer, clockInfo.data.byteOffset, clockInfo.data.byteLength).getBigInt64(32, true));
}

async function waitUntilCluster(conn: Connection, targetUnix: number, label: string) {
  for (;;) {
    const now = await getClusterClock(conn);
    const remain = targetUnix - now;
    console.log(label, "cluster_clock", now, "target", targetUnix, "remain_sec", remain);
    if (remain <= 0) return now;
    await sleep(Math.min(Math.max(remain, 1) * 1000, 15_000));
  }
}

async function fetchFinalized(conn: Connection, signature: string) {
  for (let i = 0; i < 90; i++) {
    const tx = await conn.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
    if (tx) {
      if (tx.meta == null || tx.meta.err !== null) {
        throw new Error(`finalized tx err ${signature}: ${JSON.stringify(tx.meta?.err ?? "missing meta")}`);
      }
      return tx;
    }
    await sleep(2000);
  }
  throw new Error(`not finalized ${signature}`);
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
  if (!existsSync(PAYER_PATH)) throw new Error("MISSING_PAYER_KEY");
  if (!existsSync(FIXTURE)) throw new Error("MISSING_FIXTURE");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as {
    contestId: string;
    settlementId: string;
    settlementVersion: number;
    resultHash: string;
    merkleRoot: string;
    feeBaseUnits: number;
    totalPayoutBaseUnits: number;
    entryId: string;
    payoutBaseUnits: number;
  };

  const conn = new Connection(RPC, { commitment: "confirmed" });
  const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER_PATH, "utf8"))));
  const phantomPk = new PublicKey(PHANTOM);
  const mint = new PublicKey(MINT);
  const programId = new PublicKey(PROGRAM_ID);
  const config = deriveConfigPda(programId);
  const contestIdBytes = uuidToBytes(fixture.contestId);
  const contestPda = deriveContestPda(programId, contestIdBytes);
  const vault = deriveVaultAddress(mint, contestPda, TOKEN_PROGRAM_ID);
  const settlementPda = deriveSettlementPda(programId, contestPda, fixture.settlementVersion);
  const payerAta = getAssociatedTokenAddressSync(mint, payer.publicKey);
  const phantomAta = getAssociatedTokenAddressSync(mint, phantomPk);

  const configEnv = loadConfig(process.env);
  // Prefer contest fee from DB via settlement store
  const pool = createPool(configEnv.secrets.databaseUrl);
  const db = asQueryable(pool);
  const settlements = new SettlementService(createPgSettlementStore(db));
  const prepared = await settlements.getById(fixture.settlementId);
  if (!prepared) throw new Error("settlement missing in Postgres");
  if (prepared.status !== "SETTLEMENT_PREPARED" && prepared.status !== "SETTLEMENT_SUBMITTED") {
    if (prepared.status === "SETTLEMENT_CONFIRMED" && prepared.commitSignature) {
      console.log("already_confirmed", prepared.commitSignature);
      await pool.end();
      return;
    }
    throw new Error(`unexpected status ${prepared.status}`);
  }
  if (prepared.resultHash !== fixture.resultHash || prepared.merkleRoot !== fixture.merkleRoot) {
    throw new Error("fixture hashes do not match Postgres settlement");
  }
  const fee = prepared.entryFeeBaseUnits;
  const need = BigInt(fee) * 2n;
  const usdcBal = (await getAccount(conn, payerAta)).amount;
  console.log("payer", payer.publicKey.toBase58());
  console.log("payer_usdc", usdcBal.toString(), "need", need.toString(), "entry_fee", fee);
  if (usdcBal < need) {
    throw new Error(`INSUFFICIENT_USDC have=${usdcBal} need=${need}`);
  }

  // Skip init if contest PDA already exists
  const existing = await conn.getAccountInfo(contestPda);
  if (!existing) {
    const clusterNow = await getClusterClock(conn);
    const lockAt = clusterNow + 600;
    console.log("cluster_clock", clusterNow, "lock_at", lockAt, "host", Math.floor(Date.now() / 1000));
    const data = new Uint8Array(8 + 16 + 8 + 4 + 8);
    data.set(anchorDiscriminator("initialize_contest"), 0);
    data.set(contestIdBytes, 8);
    const view = new DataView(data.buffer);
    view.setBigUint64(24, BigInt(fee), true);
    view.setUint32(32, 2, true);
    view.setBigInt64(36, BigInt(lockAt), true);
    console.log(
      "initialize_contest",
      await sendTx(
        conn,
        new Transaction().add(
          new TransactionInstruction({
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
          }),
        ),
        [payer],
      ),
    );
    // Fund phantom SOL if low
    const phantomSol = await conn.getBalance(phantomPk);
    if (phantomSol < 40_000_000) {
      await sleep(3000);
      console.log(
        "fund_phantom_sol",
        await sendTx(
          conn,
          new Transaction().add(
            SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: phantomPk, lamports: 50_000_000 }),
          ),
          [payer],
        ),
      );
    }
    try {
      await getAccount(conn, phantomAta);
    } catch {
      await sleep(3000);
      console.log(
        "create_phantom_ata",
        await sendTx(
          conn,
          new Transaction().add(
            createAssociatedTokenAccountInstruction(payer.publicKey, phantomAta, phantomPk, mint),
          ),
          [payer],
        ),
      );
    }

    const bob = Keypair.generate();
    await sleep(3000);
    console.log(
      "fund_bob_sol",
      await sendTx(
        conn,
        new Transaction().add(
          SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: bob.publicKey, lamports: 50_000_000 }),
        ),
        [payer],
      ),
    );
    const bobAta = getAssociatedTokenAddressSync(mint, bob.publicKey);
    await sleep(3000);
    console.log(
      "fund_bob_usdc",
      await sendTx(
        conn,
        new Transaction().add(
          createAssociatedTokenAccountInstruction(payer.publicKey, bobAta, bob.publicKey, mint),
          createTransferCheckedInstruction(payerAta, mint, bobAta, payer.publicKey, BigInt(fee), 6),
        ),
        [payer],
      ),
    );

    async function deposit(user: Keypair, ata: PublicKey) {
      const clk = await getClusterClock(conn);
      if (clk >= lockAt) throw new Error(`cluster clock ${clk} already past lock_at ${lockAt}; aborting deposit`);
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

    await sleep(3000);
    console.log("deposit_payer", await deposit(payer, payerAta));
    await sleep(3000);
    console.log("deposit_bob", await deposit(bob, bobAta));

    await waitUntilCluster(conn, lockAt, "waiting_lock");
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
  } else {
    const data = existing.data;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const deposits = view.getUint32(100, true);
    const status = data[104] ?? -1;
    const lockAt = view.getBigInt64(113, true);
    const clockInfo = await conn.getAccountInfo(new PublicKey("SysvarC1ock11111111111111111111111111111111"));
    if (!clockInfo) throw new Error("clock sysvar missing");
    const clock = new DataView(clockInfo.data.buffer, clockInfo.data.byteOffset, clockInfo.data.byteLength).getBigInt64(32, true);
    console.log("contest_pda_exists", contestPda.toBase58(), "deposits", deposits, "status", status, "lockAt", lockAt.toString(), "clock", clock.toString());
    if (deposits < 2 && clock >= lockAt) {
      throw new Error(
        `LOCK_PASSED_VAULT_EMPTY deposits=${deposits} status=${status} lockAt=${lockAt} clock=${clock}. Deposit requires now < lock_at and the depositor's own signature. This contest PDA cannot be reinitialized. Not starting a second contest. Not voiding. Not marking SETTLEMENT_CONFIRMED.`,
      );
    }
  }

  const vaultBefore = Number((await getAccount(conn, vault)).amount);
  console.log("vault_before", vaultBefore);
  if (vaultBefore < prepared.totalPayoutBaseUnits + prepared.feeBaseUnits) {
    throw new Error(`vault underfunded ${vaultBefore} < ${prepared.totalPayoutBaseUnits + prepared.feeBaseUnits}`);
  }

  const settlementInfo = await conn.getAccountInfo(settlementPda);
  let commitSig: string;
  if (settlementInfo) {
    throw new Error("settlement PDA already exists; refusing a placeholder signature");
  } else {
    await sleep(3000);
    commitSig = await sendTx(
      conn,
      new Transaction().add(
        buildCommitSettlementInstruction({
          programId: PROGRAM_ID,
          initAuthority: payer.publicKey,
          configPda: config,
          contestPda,
          settlementVersion: fixture.settlementVersion,
          resultHash: fromHex32(fixture.resultHash),
          merkleRoot: fromHex32(fixture.merkleRoot!),
          totalPayoutBaseUnits: prepared.totalPayoutBaseUnits,
          feeBaseUnits: prepared.feeBaseUnits,
        }),
      ),
      [payer],
    );
    console.log("commit_settlement", commitSig);
  }

  const nowIso = new Date().toISOString();
  await settlements.markSubmitted(fixture.settlementId, commitSig, nowIso);
  const finalized = await fetchFinalized(conn, commitSig);
  if (finalized.meta?.err !== null) {
    throw new Error(`refusing confirm; finalized err ${JSON.stringify(finalized.meta?.err)}`);
  }
  await settlements.markConfirmed(fixture.settlementId, finalized.slot, new Date().toISOString());
  const confirmed = await settlements.getById(fixture.settlementId);
  const rows = await settlements.getLeaderboard(fixture.settlementId);
  const winner = rows.find((r) => r.entryId === fixture.entryId)!;
  if (winner.claimStatus === "CLAIMED") throw new Error("must not be CLAIMED");
  if (winner.destinationWallet !== PHANTOM) throw new Error("destination must be Phantom");

  const vaultAfter = Number((await getAccount(conn, vault)).amount);
  const out = {
    ...fixture,
    phase: "6.1.3",
    claimSubmitted: false,
    claimConfirmed: false,
    claimStatus: winner.claimStatus,
    settlementStatus: confirmed!.status,
    fundingGap: null,
    settlementSignature: commitSig,
    vaultBefore,
    vaultAfter,
    feeBaseUnits: prepared.feeBaseUnits,
    totalPayoutBaseUnits: prepared.totalPayoutBaseUnits,
    payoutBaseUnits: winner.netPayoutBaseUnits,
    contestPda: contestPda.toBase58(),
    vault: vault.toBase58(),
    settlementPda: settlementPda.toBase58(),
    explorer: {
      commit: `https://explorer.solana.com/tx/${commitSig}?cluster=devnet`,
      contest: `https://explorer.solana.com/address/${contestPda.toBase58()}?cluster=devnet`,
    },
    ui: {
      kickrUrl: `http://localhost:3000/#/matches/${prepared.matchId}/contests`,
      contestResultUrl: `http://localhost:3000/#/contests/${fixture.contestId}/my-result`,
      claimPrizeVisible: confirmed!.status === "SETTLEMENT_CONFIRMED",
      note: "Connect Phantom GjJYQ… in KICKR UI. Claim Prize should appear for this entry. In-app E2E claim signature NOT RUN (agent cannot click Phantom).",
    },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
