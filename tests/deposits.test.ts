import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { InMemoryContestStore } from "../contests/memory-store.js";
import { ContestService } from "../contests/service.js";
import { FootballService } from "../football/service.js";
import { InMemoryFootballStore } from "../football/store.js";
import { InMemoryRedis } from "../redis/client.js";
import { assertDevCluster, DEFAULT_ESCROW_PROGRAM_ID, FORBIDDEN_MAINNET_USDC_MINT } from "../solana/ids.js";
import { buildDepositPlan, buildDepositTransaction, deriveContestPda, deriveDepositReceipt, deriveVaultAddress } from "../solana/escrow.js";
import { DepositIndexer } from "../solana/indexer.js";
import type { DepositObservation } from "../solana/verify.js";
import { decideDeposit } from "../solana/verify.js";
import { createLocalDevProvider, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";
import { PublicKey } from "@solana/web3.js";
import { generateWallet } from "./helpers.js";

const H2H5 = "53000000-0000-4000-8000-000000000001";

function harness(mint = Keypair.generate().publicKey.toBase58()) {
  const audit = new InMemoryAuditStore();
  const football = new FootballService(
    new InMemoryFootballStore(createLocalDevProvider().catalog()),
    audit,
    { creditCap: 100, maxPlayersFromOneTeam: null },
  );
  const store = new InMemoryContestStore();
  const escrow = {
    programId: DEFAULT_ESCROW_PROGRAM_ID,
    usdcMint: mint,
    usdcDecimals: 6,
    cluster: "devnet",
    tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
  };
  const contests = new ContestService(store, football, audit, new ContestDiscoveryCache(new InMemoryRedis(), "test"), {
    reservationTtlSeconds: 600,
    maxEntriesPerMatch: null,
    maxEntriesPerContest: null,
    maxExposurePerMatch: null,
  }, escrow);
  return { audit, football, store, contests, escrow };
}

async function seat(football: FootballService, accountId: string, now: Date) {
  const players = await football.getPlayerPool(LOCAL_DEV_MATCH_UPCOMING);
  if (!players) {
    throw new Error("missing pool");
  }
  const home = players[0]?.clubId ?? "";
  const pick = (position: string, clubId: string, nth: number) => {
    const found = players.filter((player) => player.position === position && player.clubId === clubId);
    const player = found[nth];
    if (!player) {
      throw new Error(position);
    }
    return player.playerId;
  };
  const away = players.find((player) => player.clubId !== home)?.clubId ?? "";
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
  const team = await football.createTeam(accountId, LOCAL_DEV_MATCH_UPCOMING, { now, correlationId: null });
  const version = await football.saveVersion(team.id, accountId, { playerIds, captainId: playerIds[0] ?? "", viceId: playerIds[5] ?? "" }, { now, correlationId: null });
  return version.id;
}

function observation(plan: NonNullable<Awaited<ReturnType<ContestService["reserve"]>>["depositPlan"]>, wallet: string, signature: string): DepositObservation {
  return {
    labelledFixture: true,
    signature,
    commitment: "finalized",
    slot: 42,
    blockTime: Math.floor(Date.parse(plan.expiresAt) / 1000) - 10,
    succeeded: true,
    programId: plan.programId,
    sender: wallet,
    mint: plan.mint,
    vault: plan.vault,
    contestPda: plan.contestPda,
    depositReceipt: plan.depositReceipt,
    tokenProgram: plan.tokenProgramId,
    amountBaseUnits: plan.feeBaseUnits,
    reservationNonceHash: plan.reservationNonceHash,
    teamVersionId: plan.teamVersionId,
    vaultBalanceIncrease: plan.feeBaseUnits,
  };
}

describe("escrow client", () => {
  it("refuses mainnet and derives one vault from the contest pda", () => {
    expect(() => assertDevCluster("mainnet-beta")).toThrow(/mainnet/);
    expect(FORBIDDEN_MAINNET_USDC_MINT.startsWith("EPjF")).toBe(true);
    const program = new PublicKey(DEFAULT_ESCROW_PROGRAM_ID);
    const contestId = new TextEncoder().encode("0123456789abcdef").slice(0, 16);
    const mint = Keypair.generate().publicKey;
    const first = deriveContestPda(program, contestId);
    const second = deriveContestPda(program, contestId);
    expect(first.toBase58()).toBe(second.toBase58());
    const vault = deriveVaultAddress(mint, first, TOKEN_PROGRAM_ID);
    const wallet = Keypair.generate().publicKey;
    const receipt = deriveDepositReceipt(program, first, wallet);
    expect(vault.equals(receipt)).toBe(false);
    const plan = buildDepositPlan({
      config: { programId: program.toBase58(), usdcMint: mint.toBase58(), usdcDecimals: 6, cluster: "devnet" },
      contestId: "11111111-1111-4111-8111-111111111111",
      wallet: wallet.toBase58(),
      teamVersionId: "22222222-2222-4222-8222-222222222222",
      reservationNonce: "nonce-nonce-nonce",
      feeBaseUnits: 5_000_000,
      expiresAt: "2026-10-04T00:00:00.000Z",
    });
    const tx = buildDepositTransaction({ plan, feePayer: wallet, recentBlockhash: "1".repeat(32) });
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]?.keys).toHaveLength(9);
    expect(tx.instructions[0]?.keys[0]?.isSigner).toBe(true);
  });
});

describe("deposit indexer", () => {
  it("confirms once, stays pending when rpc is down, and reconciles after a failed db write", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const { contests, football, store, audit, escrow } = harness();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, { now, correlationId: null });
    const wallet = generateWallet();
    const accountId = crypto.randomUUID();
    const version = await seat(football, accountId, now);
    const reserved = await contests.reserve(contest.id, accountId, wallet.publicKey, version, { now, correlationId: null });
    expect(reserved.payment).toBe("PAYMENT COMING IN PHASE 4");
    expect(reserved.entry.status).toBe("PENDING");
    const plan = reserved.depositPlan;
    if (!plan) {
      throw new Error("expected plan");
    }
    expect(plan.mint).not.toBe(FORBIDDEN_MAINNET_USDC_MINT);
    const seen = observation(plan, wallet.publicKey, "sig-finalized-1");
    const indexer = new DepositIndexer(store, audit, escrow, async () => seen);
    store.debugFailConfirmations = 1;
    const failed = await indexer.process(seen.signature, now, null);
    expect(failed).toEqual({ outcome: "PENDING", reason: "DB_WRITE_FAILED" });
    expect((await store.getEntry(reserved.entry.id))?.status).toBe("PENDING");
    const confirmed = await indexer.process(seen.signature, now, null);
    expect(confirmed).toEqual({ outcome: "CONFIRMED", idempotent: false });
    const again = await indexer.process(seen.signature, now, null);
    expect(again).toEqual({ outcome: "CONFIRMED", idempotent: true });
    const actions = (await audit.list(20)).map((event) => event.action);
    expect(actions.filter((action) => action === "ENTRY_CONFIRMED")).toHaveLength(1);
    expect(actions.filter((action) => action === "DEPOSIT_VERIFIED")).toHaveLength(1);
    expect((await store.getEntry(reserved.entry.id))?.teamVersionId).toBe(version);
    expect((await store.getEntry(reserved.entry.id))?.depositSignature).toBe(seen.signature);

    const down = new DepositIndexer(store, audit, escrow, async () => {
      throw new Error("rpc down");
    });
    const pending = await down.process("sig-other", now, null);
    expect(pending).toEqual({ outcome: "PENDING", reason: "RPC_UNAVAILABLE" });
    expect(down.health.rpcErrors).toBe(1);
    expect((await audit.list(20)).filter((event) => event.metadata && (event.metadata as { signature?: string }).signature === "sig-other")).toHaveLength(0);
  });

  it("does not attach an unknown reservation or change the team version", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const { contests, football, store, audit, escrow } = harness();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, { now, correlationId: null });
    const alice = generateWallet();
    const bob = generateWallet();
    const aliceAccount = crypto.randomUUID();
    const bobAccount = crypto.randomUUID();
    const aliceVersion = await seat(football, aliceAccount, now);
    const bobVersion = await seat(football, bobAccount, now);
    const reservedAlice = await contests.reserve(contest.id, aliceAccount, alice.publicKey, aliceVersion, { now, correlationId: null });
    const reservedBob = await contests.reserve(contest.id, bobAccount, bob.publicKey, bobVersion, { now, correlationId: null });
    const plan = reservedAlice.depositPlan;
    if (!plan || !reservedBob.depositPlan) {
      throw new Error("expected plans");
    }
    const indexer = new DepositIndexer(store, audit, escrow, async (signature) => {
      if (signature === "unknown") {
        return { ...observation(plan, alice.publicKey, signature), reservationNonceHash: "ab".repeat(32) };
      }
      if (signature === "wrong-wallet") {
        return { ...observation(plan, bob.publicKey, signature) };
      }
      return { ...observation(plan, alice.publicKey, signature), teamVersionId: bobVersion };
    });
    expect(await indexer.process("unknown", now, null)).toMatchObject({ outcome: "REJECTED", reason: "UNKNOWN_RESERVATION" });
    expect(await indexer.process("wrong-wallet", now, null)).toMatchObject({ outcome: "REJECTED", reason: "WRONG_WALLET" });
    expect(await indexer.process("wrong-team", now, null)).toMatchObject({ outcome: "REJECTED", reason: "TEAM_VERSION_MISMATCH" });
    const aliceEntry = await store.getEntry(reservedAlice.entry.id);
    const bobEntry = await store.getEntry(reservedBob.entry.id);
    expect(aliceEntry?.status).toBe("PENDING");
    expect(bobEntry?.status).toBe("PENDING");
    expect(aliceEntry?.teamVersionId).toBe(aliceVersion);
    expect(bobEntry?.teamVersionId).toBe(bobVersion);
    expect(aliceEntry?.depositSignature).toBeNull();
    expect(bobEntry?.depositSignature).toBeNull();
  });

  it("rejects amount, mint, destination, and unfinalized fixtures without confirming", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const { contests, football, store, audit, escrow } = harness();
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, { now, correlationId: null });
    const wallet = generateWallet();
    const accountId = crypto.randomUUID();
    const version = await seat(football, accountId, now);
    const reserved = await contests.reserve(contest.id, accountId, wallet.publicKey, version, { now, correlationId: null });
    const plan = reserved.depositPlan;
    if (!plan) {
      throw new Error("expected plan");
    }
    const base = observation(plan, wallet.publicKey, "case");
    const cases: Array<[string, DepositObservation]> = [
      ["WRONG_AMOUNT", { ...base, amountBaseUnits: base.amountBaseUnits - 1, vaultBalanceIncrease: base.amountBaseUnits - 1 }],
      ["WRONG_MINT", { ...base, mint: Keypair.generate().publicKey.toBase58() }],
      ["WRONG_DESTINATION", { ...base, vault: Keypair.generate().publicKey.toBase58() }],
      ["NOT_FINALIZED", { ...base, commitment: "confirmed" }],
      ["EXPIRED", { ...base, blockTime: Math.floor(Date.parse(plan.expiresAt) / 1000) + 5 }],
    ];
    for (const [reason, observed] of cases) {
      const decision = decideDeposit({
        observation: observed,
        programId: escrow.programId,
        mint: escrow.usdcMint,
        tokenProgram: escrow.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58(),
        reservation: {
          reservationId: reserved.reservation.id,
          contestId: contest.id,
          wallet: wallet.publicKey,
          teamVersionId: version,
          amountBaseUnits: reserved.reservation.amountBaseUnits,
          nonce: reserved.reservation.nonce,
          expiresAt: reserved.reservation.expiresAt,
          status: "PENDING",
          entryStatus: "PENDING",
          entryId: reserved.entry.id,
          existingSignature: null,
        },
      });
      expect(decision).toEqual({ ok: false, reason });
    }
    expect((await store.getEntry(reserved.entry.id))?.status).toBe("PENDING");
    expect((await audit.list(10)).some((event) => event.action === "ENTRY_CONFIRMED")).toBe(false);
  });

  it("has no spend instruction and does not grant a manual withdrawal permission", () => {
    const root = path.resolve(process.cwd(), "escrow/programs/kickr_escrow/src");
    const files = readdirSync(root, { recursive: true })
      .filter((name) => String(name).endsWith(".rs"))
      .map((name) => readFileSync(path.join(root, String(name)), "utf8"))
      .join("\n");
    for (const needle of ["fn withdraw", "fn admin_transfer", "fn arbitrary_transfer", "fn withdraw_all", "fn sweep"]) {
      expect(files).not.toContain(needle);
    }
    const permissions = readFileSync(path.resolve(process.cwd(), "rbac/permissions.ts"), "utf8");
    expect(permissions).not.toContain('"ARBITRARY_ESCROW_TRANSFER"');
    expect(permissions).not.toContain('"MANUAL_WITHDRAWAL"');
    expect(permissions).not.toContain('"MOVE_ESCROW"');
  });
});
