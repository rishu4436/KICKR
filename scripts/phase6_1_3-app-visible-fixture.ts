/**
 * Phase 6.1.3: seed Postgres contest + settlement visible to Phantom, then (when funded)
 * initialize/deposit/lock/commit_settlement on Devnet with matching contest id + hashes.
 * Does NOT submit claim_payout. Does NOT INSERT claim_status CLAIMED. Does NOT print payer secret.
 *
 * Usage: node --env-file=.env ./node_modules/tsx/dist/cli.mjs scripts/phase6_1_3-app-visible-fixture.ts
 */
import { writeFileSync, existsSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAccount,
} from "@solana/spl-token";
import { loadConfig } from "../config/load.ts";
import { asQueryable, createPool } from "../db/pool.ts";
import { createPgFootballStore } from "../db/football-repository.ts";
import { createPgContestStore } from "../db/contest-repository.ts";
import { createPgSettlementStore } from "../db/settlement-repository.ts";
import { createPgAccountRepository, createPgAuditStore } from "../db/repositories.ts";
import { FootballService } from "../football/service.ts";
import { ContestService } from "../contests/service.ts";
import { ContestDiscoveryCache } from "../contests/discovery.ts";
import { createIoredisClient } from "../redis/ioredis-client.ts";
import { SettlementService } from "../settlement/service.ts";
import { createLocalDevProvider, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.ts";
import {
  anchorDiscriminator, buildCommitSettlementInstruction,
  deriveConfigPda, deriveContestPda, deriveDepositReceipt, deriveVaultAddress, deriveSettlementPda,
  uuidToBytes, nonceHash,
} from "../solana/escrow.ts";
import { fromHex32 } from "../settlement/merkle.ts";
import { newId } from "../shared/ids.ts";

const PHANTOM = "GjJYQen9kw4K3ETpeKCTbxvmfzDSYPJoG2Wy3kC9Je5S";
const PROGRAM_ID = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const RPC = "https://solana-devnet.api.onfinality.io/public";
const PAYER_PATH = "/tmp/kickr-devnet-payer.json";
const OUT = "/tmp/kickr-phase6_1_3-fixture.json";
const H2H5 = "53000000-0000-4000-8000-000000000001";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function sendTx(conn: Connection, tx: Transaction, signers: Keypair[]): Promise<string> {
  const latest = await conn.getLatestBlockhash("confirmed");
  tx.feePayer = signers[0]!.publicKey;
  tx.recentBlockhash = latest.blockhash;
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    const st = await conn.getSignatureStatuses([sig], { searchTransactionHistory: true });
    const v = st.value[0];
    if (v?.err) throw new Error(`tx failed ${sig}: ${JSON.stringify(v.err)}`);
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return sig;
  }
  throw new Error(`timeout ${sig}`);
}

async function ensureAccount(
  accounts: ReturnType<typeof createPgAccountRepository>,
  wallet: string,
  now: Date,
) {
  const existing = await accounts.findByWallet(wallet);
  if (existing) return existing;
  const iso = now.toISOString();
  return accounts.insert({
    id: newId(),
    walletAddress: wallet,
    createdAt: iso,
    updatedAt: iso,
    deletedAt: null,
  });
}

async function buildXi(football: FootballService, matchId: string, accountId: string, now: Date) {
  const players = await football.getPlayerPool(matchId);
  if (!players || players.length < 11) throw new Error("player pool missing");
  const home = players[0]!.clubId;
  const away = players.find((p) => p.clubId !== home)?.clubId ?? "";
  const pick = (position: string, clubId: string, nth: number) => {
    const found = players.filter((p) => p.position === position && p.clubId === clubId);
    const player = found[nth];
    if (!player) throw new Error(`missing ${position} ${clubId} #${nth}`);
    return player.playerId;
  };
  const playerIds = [
    pick("GK", home, 0),
    pick("DEF", home, 0),
    pick("DEF", home, 1),
    pick("DEF", home, 2),
    pick("DEF", home, 3),
    pick("MID", home, 0),
    pick("MID", home, 1),
    pick("MID", away, 0),
    pick("DEF", away, 0),
    pick("FWD", away, 1),
    pick("MID", away, 1),
  ];
  const team = await football.createTeam(accountId, matchId, { now, correlationId: "phase6.1.3" });
  return football.saveVersion(
    team.id,
    accountId,
    { playerIds, captainId: playerIds[0]!, viceId: playerIds[5]! },
    { now, correlationId: "phase6.1.3" },
  );
}

async function main() {
  const config = loadConfig(process.env);
  const pool = createPool(config.secrets.databaseUrl);
  const db = asQueryable(pool);
  const now = new Date();
  const audit = createPgAuditStore(db);
  const accounts = createPgAccountRepository(db);
  const footballStore = createPgFootballStore(db);
  const sports = createLocalDevProvider();
  await footballStore.upsertCatalog(sports.catalog());
  const football = new FootballService(footballStore, audit, config.server.fantasy);
  const redis = createIoredisClient(config.secrets.redisUrl);
  const contestStore = createPgContestStore(pool);
  const contests = new ContestService(
    contestStore,
    football,
    audit,
    new ContestDiscoveryCache(redis, config.public.environment),
    config.server.contests,
    {
      programId: config.server.solana.escrowProgramId,
      usdcMint: config.server.solana.usdcMint || MINT,
      usdcDecimals: config.server.solana.usdcDecimals,
      cluster: config.server.solana.cluster,
    },
  );
  const settlements = new SettlementService(createPgSettlementStore(db));

  const phantomAccount = await ensureAccount(accounts, PHANTOM, now);
  const opponent = Keypair.generate();
  const opponentAccount = await ensureAccount(accounts, opponent.publicKey.toBase58(), now);

  const matchId = LOCAL_DEV_MATCH_UPCOMING;
  const phantomVersion = await buildXi(football, matchId, phantomAccount.id, now);
  const opponentVersion = await buildXi(football, matchId, opponentAccount.id, now);

  const template = await contestStore.getTemplate(H2H5);
  if (!template) throw new Error("H2H-5 template missing");
  let contest = await contests.ensureOpenContest(matchId, template.id, {
    now,
    correlationId: "phase6.1.3",
  });
  if (contest.status === "FULL" || contest.filledCount >= contest.capacity) {
    contest = await contests.ensureOpenContest(matchId, template.id, {
      now: new Date(now.getTime() + 1000),
      correlationId: "phase6.1.3-fresh",
    });
  }
  if (contest.status === "FULL" || contest.filledCount >= contest.capacity) {
    throw new Error(`no joinable contest (status=${contest.status} filled=${contest.filledCount})`);
  }
  console.log("using_contest", contest.id, contest.status, contest.filledCount);

  const mint = config.server.solana.usdcMint || MINT;
  const programId = new PublicKey(config.server.solana.escrowProgramId || PROGRAM_ID);
  const contestPda = deriveContestPda(programId, uuidToBytes(contest.id));
  const vault = deriveVaultAddress(new PublicKey(mint), contestPda, TOKEN_PROGRAM_ID);

  async function seat(wallet: string, teamVersionId: string, scoreBias: number) {
    const accountId = wallet === PHANTOM ? phantomAccount.id : opponentAccount.id;
    const reserved = await contests.reserve(
      contest.id,
      accountId,
      wallet,
      teamVersionId,
      { now, correlationId: "phase6.1.3" },
    );
    const signature = `app-fixture-deposit-${reserved.reservation.id}`;
    await contestStore.submitDeposit(reserved.reservation.id, signature, now);
    const confirmed = await contestStore.confirmVerifiedDeposit({
      reservationId: reserved.reservation.id,
      signature,
      slot: 1,
      blockTime: Math.floor(now.getTime() / 1000),
      amountBaseUnits: contest.entryFeeBaseUnits,
      mint,
      vault: vault.toBase58(),
      depositReceipt: `fixture-receipt-${reserved.reservation.id}`,
      contestPda: contestPda.toBase58(),
      teamVersionId,
      now,
    });
    return { entry: confirmed.entry, scoreBias, teamVersionId, wallet };
  }

  const phantomSeat = await seat(PHANTOM, phantomVersion.id, 19500);
  const opponentSeat = await seat(opponent.publicKey.toBase58(), opponentVersion.id, 8000);

  const feePolicy = {
    id: contest.rulesSnapshot.feePolicyId,
    version: contest.rulesSnapshot.feePolicyVersion,
    rateBps: contest.rulesSnapshot.feeRateBps,
    label: "DEV",
  };
  const payoutPolicy = {
    id: contest.rulesSnapshot.payoutPolicyId,
    version: contest.rulesSnapshot.payoutPolicyVersion,
    policyType: contest.rulesSnapshot.payoutPolicyType,
    configuration: contest.rulesSnapshot.payoutConfiguration,
  };

  const calculated = await settlements.calculate({
    contestId: contest.id,
    matchId,
    matchSettlementGate: "FINAL",
    entryFeeBaseUnits: contest.entryFeeBaseUnits,
    seatCount: contest.rulesSnapshot.capacity,
    contestRules: contest.rulesSnapshot,
    rulesetName: contest.rulesSnapshot.scoringRulesetName || "DEV_V1",
    rulesetVersion: contest.rulesSnapshot.scoringRulesetVersion || 1,
    feePolicy,
    payoutPolicy,
    entries: [
      {
        entryId: phantomSeat.entry.id,
        teamVersionId: phantomSeat.teamVersionId,
        destinationWallet: PHANTOM,
        baseScoreMilliPoints: phantomSeat.scoreBias,
        finalScoreMilliPoints: phantomSeat.scoreBias,
        xi: phantomVersion.playerIds,
        captainId: phantomVersion.captainId,
        viceId: phantomVersion.viceId,
      },
      {
        entryId: opponentSeat.entry.id,
        teamVersionId: opponentSeat.teamVersionId,
        destinationWallet: opponent.publicKey.toBase58(),
        baseScoreMilliPoints: opponentSeat.scoreBias,
        finalScoreMilliPoints: opponentSeat.scoreBias,
        xi: opponentVersion.playerIds,
        captainId: opponentVersion.captainId,
        viceId: opponentVersion.viceId,
      },
    ],
    actorId: phantomAccount.id,
    nowIso: now.toISOString(),
  });

  await settlements.review(calculated.id, phantomAccount.id, now.toISOString());
  await settlements.approve(calculated.id, phantomAccount.id, now.toISOString());
  const prepared = await settlements.prepare(calculated.id, now.toISOString());
  const rows = await settlements.getLeaderboard(prepared.id);
  const winner = rows.find((r) => r.rank === 1)!;
  if (winner.destinationWallet !== PHANTOM) throw new Error(`expected Phantom winner, got ${winner.destinationWallet}`);
  if (winner.claimStatus === "CLAIMED") throw new Error("fixture must not set CLAIMED");
  if (prepared.resultHash === "1".repeat(64)) throw new Error("refusing all-ones result hash");

  let settlementSignature: string | null = null;
  let fundingGap: string | null = null;
  let payerUsdc = "0";
  let vaultBefore: number | null = null;
  let vaultAfter: number | null = null;
  let explorer: { commit: string; contest: string } | null = null;

  if (existsSync(PAYER_PATH)) {
    const payer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(PAYER_PATH, "utf8"))));
    const conn = new Connection(RPC, { commitment: "confirmed" });
    const payerAta = getAssociatedTokenAddressSync(new PublicKey(MINT), payer.publicKey);
    try {
      payerUsdc = (await getAccount(conn, payerAta)).amount.toString();
    } catch {
      payerUsdc = "missing";
    }
    const fee = prepared.entryFeeBaseUnits;
    const need = BigInt(fee) * 2n;
    if (BigInt(payerUsdc === "missing" ? "0" : payerUsdc) < need) {
      fundingGap = `Payer ${payer.publicKey.toBase58()} USDC=${payerUsdc}; need ${need.toString()} (2× entry fee ${fee}). On-chain commit_settlement NOT CREATED.`;
    } else {
      // Real Devnet path: same contest UUID + approved result hash/merkle/payout/fee.
      const configPda = deriveConfigPda(programId);
      const settlementPda = deriveSettlementPda(programId, contestPda, prepared.settlementVersion);
      const phantomPk = new PublicKey(PHANTOM);
      const phantomAta = getAssociatedTokenAddressSync(new PublicKey(MINT), phantomPk);
      const mintPk = new PublicKey(MINT);

      // Long lock window so deposits finish before lock time (RPC rate limits).
      const lockAt = Math.floor(Date.now() / 1000) + 180;
      {
        const data = new Uint8Array(8 + 16 + 8 + 4 + 8);
        data.set(anchorDiscriminator("initialize_contest"), 0);
        data.set(uuidToBytes(contest.id), 8);
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
                  { pubkey: configPda, isSigner: false, isWritable: false },
                  { pubkey: contestPda, isSigner: false, isWritable: true },
                  { pubkey: mintPk, isSigner: false, isWritable: false },
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
      }

      const phantomSol = await conn.getBalance(phantomPk);
      if (phantomSol < 40_000_000) {
        await sleep(4000);
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
        await sleep(4000);
        console.log(
          "create_phantom_ata",
          await sendTx(
            conn,
            new Transaction().add(
              createAssociatedTokenAccountInstruction(payer.publicKey, phantomAta, phantomPk, mintPk),
            ),
            [payer],
          ),
        );
      }

      const bob = Keypair.generate();
      await sleep(4000);
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
      const bobAta = getAssociatedTokenAddressSync(mintPk, bob.publicKey);
      await sleep(4000);
      console.log(
        "fund_bob_usdc",
        await sendTx(
          conn,
          new Transaction().add(
            createAssociatedTokenAccountInstruction(payer.publicKey, bobAta, bob.publicKey, mintPk),
            createTransferCheckedInstruction(payerAta, mintPk, bobAta, payer.publicKey, BigInt(fee), 6),
          ),
          [payer],
        ),
      );

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
            { pubkey: mintPk, isSigner: false, isWritable: false },
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
      console.log("deposit_payer", await deposit(payer, payerAta));
      await sleep(4000);
      console.log("deposit_bob", await deposit(bob, bobAta));

      const waitMs = Math.max(0, lockAt * 1000 - Date.now()) + 5000;
      console.log("waiting_lock_ms", waitMs);
      await sleep(waitMs);
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

      vaultBefore = Number((await getAccount(conn, vault)).amount);
      console.log("vault_before", vaultBefore);
      await sleep(4000);
      settlementSignature = await sendTx(
        conn,
        new Transaction().add(
          buildCommitSettlementInstruction({
            programId: PROGRAM_ID,
            initAuthority: payer.publicKey,
            configPda,
            contestPda,
            settlementVersion: prepared.settlementVersion,
            resultHash: fromHex32(prepared.resultHash),
            merkleRoot: fromHex32(prepared.merkleRoot!),
            totalPayoutBaseUnits: prepared.totalPayoutBaseUnits,
            feeBaseUnits: prepared.feeBaseUnits,
          }),
        ),
        [payer],
      );
      console.log("commit_settlement", settlementSignature);
      vaultAfter = Number((await getAccount(conn, vault)).amount);

      const slot = await conn.getSlot("confirmed");
      const nowIso = new Date().toISOString();
      await settlements.markSubmitted(prepared.id, settlementSignature, nowIso);
      await settlements.markConfirmed(prepared.id, slot, nowIso);
      explorer = {
        commit: `https://explorer.solana.com/tx/${settlementSignature}?cluster=devnet`,
        contest: `https://explorer.solana.com/address/${contestPda.toBase58()}?cluster=devnet`,
      };
      console.log("settlement_pda", settlementPda.toBase58());
    }
  } else {
    fundingGap = "Missing /tmp/kickr-devnet-payer.json; on-chain commit NOT CREATED.";
  }

  const finalSettlement = await settlements.getById(prepared.id);
  const finalRows = await settlements.getLeaderboard(prepared.id);
  const finalWinner = finalRows.find((r) => r.rank === 1)!;

  const out = {
    phase: "6.1.3",
    claimSubmitted: false,
    claimConfirmed: false,
    claimStatus: finalWinner.claimStatus,
    settlementStatus: finalSettlement!.status,
    fundingGap,
    payerUsdc,
    programId: PROGRAM_ID,
    mint,
    contestId: contest.id,
    matchId,
    entryId: finalWinner.entryId,
    settlementId: prepared.id,
    settlementVersion: prepared.settlementVersion,
    claimant: PHANTOM,
    destination: finalWinner.destinationWallet,
    teamVersionId: finalWinner.teamVersionId,
    scoreMilliPoints: finalWinner.finalScoreMilliPoints,
    rank: finalWinner.rank,
    payoutBaseUnits: finalWinner.netPayoutBaseUnits,
    feeBaseUnits: prepared.feeBaseUnits,
    totalPayoutBaseUnits: prepared.totalPayoutBaseUnits,
    resultHash: prepared.resultHash,
    merkleRoot: prepared.merkleRoot,
    settlementHash: prepared.settlementHash,
    contestPda: contestPda.toBase58(),
    vault: vault.toBase58(),
    settlementSignature,
    vaultBefore,
    vaultAfter,
    explorer,
    ui: {
      kickrUrl: `http://localhost:3000/#/matches/${matchId}/contests`,
      claimPrizeVisible: finalSettlement!.status === "SETTLEMENT_CONFIRMED",
      note:
        finalSettlement!.status === "SETTLEMENT_CONFIRMED"
          ? "Connect Phantom in KICKR UI to see Claim Prize. In-app E2E claim signature NOT RUN (agent cannot click Phantom)."
          : "Settlement not SETTLEMENT_CONFIRMED; Claim Prize hidden until real commit_settlement.",
    },
  };
  writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 2));
  await pool.end();
  await redis.close().catch(() => undefined);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
