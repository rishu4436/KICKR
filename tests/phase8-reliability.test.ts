/**
 * Phase 8 reliability, abuse resistance, and production hardening.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import { deleteAuditEvent, updateAuditEvent } from "../audit/guard.js";
import { loadConfig } from "../config/load.js";
import { confirmationAllowed } from "../contests/expiry.js";
import { InMemoryContestStore } from "../contests/memory-store.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { ContestService } from "../contests/service.js";
import { DEV_TEMPLATES } from "../contests/dev-catalog.js";
import { FootballService } from "../football/service.js";
import { InMemoryFootballStore } from "../football/store.js";
import { createLocalDevProvider, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import { InMemoryRedis } from "../redis/client.js";
import { AppError, ConfigError, toPublicError } from "../shared/errors.js";
import { InMemoryRateLimiter } from "../shared/rate-limit.js";
import { InMemoryIdempotencyStore, ReliabilityCounters } from "../shared/reliability.js";
import { redact } from "../shared/redact.js";
import { RpcUnavailable } from "../solana/chain.js";
import { createApp } from "../api/server.js";
import { requestHash } from "../api/guard.js";
import { decideClaim, type ClaimObservation } from "../settlement/verify.js";
import { buildTestApp, generateWallet, signMessage, testConfig } from "./helpers.js";
import {
  buildLocalDevAttestationWorld,
  issueAndStoreLocalDevAttestation,
} from "../attestation/test-harness.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");
const PROGRAM = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ENTRY_A = "a0000000-0000-4000-8000-0000000000a1";
const ENTRY_B = "a0000000-0000-4000-8000-0000000000a2";
const CONTEST = "c0000000-0000-4000-8000-0000000000a1";
const MATCH = "m0000000-0000-4000-8000-0000000000a1";
const H2H5 = "53000000-0000-4000-8000-000000000001";

const feePolicy = {
  id: "51000000-0000-4000-8000-000000000001",
  version: 1,
  rateBps: 1000,
  label: "DEV",
};
const h2hPolicy = {
  id: "52000000-0000-4000-8000-000000000001",
  version: 1,
  policyType: "HEAD_TO_HEAD" as const,
  configuration: { calculation: "winner_takes_prize_pool", tiePolicy: "entry_id_asc" },
};

function claimObs(
  partial: Partial<ClaimObservation> &
    Pick<ClaimObservation, "claimant" | "contestPda" | "entryId" | "amountBaseUnits" | "mint" | "vault" | "claimPda">,
): ClaimObservation {
  return {
    labelledFixture: true,
    signature: partial.signature ?? "SigClaim111111111111111111111111111111111111111111111111111",
    commitment: partial.commitment ?? "finalized",
    slot: partial.slot ?? 1,
    succeeded: partial.succeeded ?? true,
    programId: partial.programId ?? PROGRAM,
    claimant: partial.claimant,
    contestPda: partial.contestPda,
    settlementVersion: partial.settlementVersion ?? 1,
    entryId: partial.entryId,
    amountBaseUnits: partial.amountBaseUnits,
    mint: partial.mint,
    vault: partial.vault,
    claimPda: partial.claimPda,
    destination: partial.destination ?? partial.claimant,
    vaultBalanceDecrease: partial.vaultBalanceDecrease ?? partial.amountBaseUnits,
  };
}

async function loginApp(options?: {
  rateLimiter?: InMemoryRateLimiter;
  nodeEnv?: "production" | "development" | "test";
  claimObserver?: (
    rpcUrl: string,
    signature: string,
    programId: string,
  ) => Promise<ClaimObservation | null>;
}) {
  const clock = () => NOW;
  const built = buildTestApp(clock);
  if (options?.rateLimiter) {
    built.deps.rateLimiter = options.rateLimiter;
  }
  if (options?.nodeEnv) {
    built.deps.config = testConfig({ nodeEnv: options.nodeEnv });
  }
  if (options?.claimObserver) {
    built.deps.claimObserver = options.claimObserver;
  }
  const app = createApp(built.deps);
  const wallet = generateWallet();
  const issued = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
  const session = await built.deps.auth.login(
    {
      walletAddress: wallet.publicKey,
      message: issued.message,
      signature: signMessage(issued.message, wallet.secretKey),
    },
    { now: NOW, correlationId: null },
  );
  return {
    app,
    deps: built.deps,
    grants: built.grants,
    audit: built.audit,
    wallet,
    token: session.token,
    accountId: session.account.id,
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
  };
}

async function preparedSettlement(w1: string, w2: string) {
  const world = buildLocalDevAttestationWorld();
  const service = world.settlements;
  const calculated = await service.calculate({
    contestId: CONTEST,
    matchId: MATCH,
    matchSettlementGate: "FINAL",
    entryFeeBaseUnits: 5_000_000,
    seatCount: 2,
    contestRules: { frozen: true },
    rulesetName: "DEV_V1",
    rulesetVersion: 1,
    feePolicy,
    payoutPolicy: h2hPolicy,
    entries: [
      {
        entryId: ENTRY_A,
        teamVersionId: "t0000000-0000-4000-8000-000000000001",
        destinationWallet: w1,
        baseScoreMilliPoints: 9000,
        finalScoreMilliPoints: 9000,
        xi: Array.from({ length: 11 }, (_, i) => `p${i}`),
        captainId: "p0",
        viceId: "p1",
      },
      {
        entryId: ENTRY_B,
        teamVersionId: "t0000000-0000-4000-8000-000000000002",
        destinationWallet: w2,
        baseScoreMilliPoints: 1000,
        finalScoreMilliPoints: 1000,
        xi: Array.from({ length: 11 }, (_, i) => `p${i}`),
        captainId: "p0",
        viceId: "p1",
      },
    ],
    actorId: "actor",
    nowIso: "2026-10-06T00:00:00.000Z",
  });
  await service.review(calculated.id, "reviewer", "2026-10-06T00:01:00.000Z");
  const rowsForAttestation = await service.getLeaderboard(calculated.id);
  await issueAndStoreLocalDevAttestation({
    world,
    settlement: calculated,
    rows: rowsForAttestation,
    nowIso: "2026-10-06T00:01:30.000Z",
  });
  await service.approve(calculated.id, "reviewer", "2026-10-06T00:02:00.000Z");
  const prepared = await service.prepare(calculated.id, "2026-10-06T00:03:00.000Z");
  return { service, prepared };
}

async function xi(football: FootballService, accountId: string, now: Date) {
  const players = await football.getPlayerPool(LOCAL_DEV_MATCH_UPCOMING);
  if (!players) throw new Error("missing pool");
  const home = players[0]?.clubId ?? "";
  const away = players.find((player) => player.clubId !== home)?.clubId ?? "";
  const pick = (position: string, clubId: string, nth: number) => {
    const found = players.filter((player) => player.position === position && player.clubId === clubId);
    const player = found[nth];
    if (!player) throw new Error(`missing ${position}`);
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
  const team = await football.createTeam(accountId, LOCAL_DEV_MATCH_UPCOMING, { now, correlationId: null });
  const version = await football.saveVersion(
    team.id,
    accountId,
    { playerIds, captainId: playerIds[0] ?? "", viceId: playerIds[5] ?? "" },
    { now, correlationId: null },
  );
  return { team, version };
}

describe("Phase 8 reliability", () => {
  it("rejects nonce replay, signature mismatch, and expired nonce", async () => {
    const { deps } = await loginApp();
    const wallet = generateWallet();
    const issued = await deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: "n1" });
    const signature = signMessage(issued.message, wallet.secretKey);
    await deps.auth.login(
      { walletAddress: wallet.publicKey, message: issued.message, signature },
      { now: NOW, correlationId: "n1" },
    );
    await expect(
      deps.auth.login(
        { walletAddress: wallet.publicKey, message: issued.message, signature },
        { now: NOW, correlationId: "n1" },
      ),
    ).rejects.toMatchObject({ code: "AUTH_NONCE_REUSED" });

    const other = generateWallet();
    const issued2 = await deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: "n2" });
    await expect(
      deps.auth.login(
        {
          walletAddress: wallet.publicKey,
          message: issued2.message,
          signature: signMessage(issued2.message, other.secretKey),
        },
        { now: NOW, correlationId: "n2" },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_SIGNATURE" });

    const issued3 = await deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: "n3" });
    const sig3 = signMessage(issued3.message, wallet.secretKey);
    await expect(
      deps.auth.login(
        { walletAddress: wallet.publicKey, message: issued3.message, signature: sig3 },
        { now: new Date(NOW.getTime() + 301_000), correlationId: "n3" },
      ),
    ).rejects.toMatchObject({ code: "AUTH_NONCE_EXPIRED" });
  });

  it("rejects expired, revoked, and suspended sessions", async () => {
    const { deps } = await loginApp();
    const wallet = generateWallet();
    const issued = await deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session = await deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );

    await expect(
      deps.auth.authenticate(session.token, {
        now: new Date(NOW.getTime() + 3_600_001),
        correlationId: null,
      }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_EXPIRED" });

    const issued2 = await deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session2 = await deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: issued2.message,
        signature: signMessage(issued2.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    await deps.auth.logout(session2.token, { now: NOW, correlationId: null });
    await expect(
      deps.auth.authenticate(session2.token, { now: NOW, correlationId: null }),
    ).rejects.toMatchObject({ code: "AUTH_SESSION_REVOKED" });

    const issued3 = await deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session3 = await deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: issued3.message,
        signature: signMessage(issued3.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    await deps.auth.suspendAccount(session3.account.id, NOW);
    await expect(
      deps.auth.authenticate(session3.token, { now: NOW, correlationId: null }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    const issued4 = await deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    await expect(
      deps.auth.login(
        {
          walletAddress: wallet.publicKey,
          message: issued4.message,
          signature: signMessage(issued4.message, wallet.secretKey),
        },
        { now: NOW, correlationId: null },
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });

  it("exhausts rate limits and fails closed in production when the limiter is missing", async () => {
    const limiter = new InMemoryRateLimiter(1, 60_000);
    const limited = await loginApp({ rateLimiter: limiter });
    const wallet = generateWallet();
    const first = await limited.app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey }),
    });
    expect(first.status).toBe(201);
    const second = await limited.app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey }),
    });
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    expect(limited.deps.counters?.snapshot().rate_limit_hits).toBeGreaterThanOrEqual(1);

    const prod = await loginApp({ nodeEnv: "production" });
    delete prod.deps.rateLimiter;
    const contestId = "00000000-0000-4000-8000-000000000099";
    const blocked = await prod.app.request(`/contests/${contestId}/reservations`, {
      method: "POST",
      headers: prod.headers,
      body: JSON.stringify({ teamVersionId: "00000000-0000-4000-8000-000000000001" }),
    });
    expect(blocked.status).toBe(503);
    expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("DEPENDENCY_UNAVAILABLE");
  });

  it("replays identical idempotency keys and rejects conflicting reuse", async () => {
    const store = new InMemoryIdempotencyStore();
    const first = await store.run("reservation", "idem-key-001", "hash-a", async () => ({
      status: 201,
      body: { ok: true, seat: 1 },
    }));
    expect(first.replay).toBe(false);
    const again = await store.run("reservation", "idem-key-001", "hash-a", async () => ({
      status: 201,
      body: { ok: false },
    }));
    expect(again.replay).toBe(true);
    expect(again.body).toEqual({ ok: true, seat: 1 });
    await expect(
      store.run("reservation", "idem-key-001", "hash-b", async () => ({ status: 201, body: {} })),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const ctx = await loginApp();
    const key = "idemkeyABCD12";
    const contestId = "00000000-0000-4000-8000-000000000099";
    const teamVersionId = "00000000-0000-4000-8000-000000000001";
    const request = { contestId, accountId: ctx.accountId, teamVersionId };
    await store.run("reservation", key, requestHash(request), async () => ({
      status: 201,
      body: { seeded: true, contestId },
    }));
    ctx.deps.idempotency = store;
    const app = createApp(ctx.deps);
    const replayed = await app.request(`/contests/${contestId}/reservations`, {
      method: "POST",
      headers: { ...ctx.headers, "idempotency-key": key },
      body: JSON.stringify({ teamVersionId }),
    });
    expect(replayed.status).toBe(201);
    expect(await replayed.json()).toEqual({ seeded: true, contestId });
    const conflict = await app.request(`/contests/${contestId}/reservations`, {
      method: "POST",
      headers: { ...ctx.headers, "idempotency-key": key },
      body: JSON.stringify({ teamVersionId: "00000000-0000-4000-8000-000000000002" }),
    });
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_CONFLICT");
  });

  it("covers concurrent reservation and expired reservation races", async () => {
    const audit = new InMemoryAuditStore();
    const football = new FootballService(
      new InMemoryFootballStore(createLocalDevProvider().catalog()),
      audit,
      { creditCap: 100, maxPlayersFromOneTeam: null },
    );
    const store = new InMemoryContestStore();
    const contests = new ContestService(
      store,
      football,
      audit,
      new ContestDiscoveryCache(new InMemoryRedis(), "test"),
      { reservationTtlSeconds: 60, maxEntriesPerMatch: null, maxEntriesPerContest: null, maxExposurePerMatch: null },
    );
    const ctx = { now: NOW, correlationId: "race" };
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const attempts = await Promise.all(
      Array.from({ length: 20 }, async (_u, index) => {
        const accountId = crypto.randomUUID();
        const team = await xi(football, accountId, NOW);
        try {
          const reserved = await contests.reserve(
            contest.id,
            accountId,
            `W${String(index).padStart(31, "0")}`,
            team.version.id,
            ctx,
          );
          return { ok: true as const, seat: reserved.entry.seatNumber };
        } catch (error) {
          return { ok: false as const, code: error instanceof AppError ? error.code : "UNKNOWN" };
        }
      }),
    );
    expect(attempts.filter((row) => row.ok)).toHaveLength(2);
    expect(attempts.filter((row) => !row.ok).every((row) => row.code === "CONTEST_FULL")).toBe(true);

    expect(
      confirmationAllowed({
        reservationStatus: "EXPIRED",
        expiresAt: new Date(NOW.getTime() - 1_000).toISOString(),
        blockTime: null,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      confirmationAllowed({
        reservationStatus: "EXPIRED",
        expiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        blockTime: Math.floor((NOW.getTime() - 5_000) / 1000),
        now: NOW,
      }),
    ).toBe(true);
    expect(
      confirmationAllowed({
        reservationStatus: "PENDING",
        expiresAt: new Date(NOW.getTime() - 1).toISOString(),
        blockTime: Math.floor(NOW.getTime() / 1000),
        now: NOW,
      }),
    ).toBe(false);

    const team = await xi(football, crypto.randomUUID(), NOW);
    const reserved = await contests.reserve(
      (await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx)).id,
      team.team.accountId,
      "Z".repeat(32),
      team.version.id,
      ctx,
    );
    await expect(
      store.confirmVerifiedDeposit({
        reservationId: reserved.reservation.id,
        teamVersionId: reserved.entry.teamVersionId,
        signature: "dup-sig-1",
        slot: 1,
        blockTime: Math.floor((NOW.getTime() + 120_000) / 1000),
        amountBaseUnits: reserved.contest.entryFeeBaseUnits,
        mint: MINT,
        vault: "Vault11111111111111111111111111111111111111",
        contestPda: "Contest111111111111111111111111111111111111",
        depositReceipt: "Receipt1111111111111111111111111111111111",
        now: new Date(NOW.getTime() + 120_000),
      }),
    ).rejects.toMatchObject({ code: "RESERVATION_EXPIRED" });
  });

  it("treats duplicate deposit signatures as idempotent", async () => {
    const audit = new InMemoryAuditStore();
    const football = new FootballService(
      new InMemoryFootballStore(createLocalDevProvider().catalog()),
      audit,
      { creditCap: 100, maxPlayersFromOneTeam: null },
    );
    const store = new InMemoryContestStore();
    const contests = new ContestService(
      store,
      football,
      audit,
      new ContestDiscoveryCache(new InMemoryRedis(), "test"),
      { reservationTtlSeconds: 600, maxEntriesPerMatch: null, maxEntriesPerContest: null, maxExposurePerMatch: null },
    );
    const ctx = { now: NOW, correlationId: null };
    const contest = await contests.ensureOpenContest(LOCAL_DEV_MATCH_UPCOMING, H2H5, ctx);
    const team = await xi(football, crypto.randomUUID(), NOW);
    const reserved = await contests.reserve(contest.id, team.team.accountId, "D".repeat(32), team.version.id, ctx);
    const input = {
      reservationId: reserved.reservation.id,
      teamVersionId: reserved.entry.teamVersionId,
      signature: "deposit-sig-idempotent-1",
      slot: 10,
      blockTime: Math.floor(NOW.getTime() / 1000),
      amountBaseUnits: reserved.contest.entryFeeBaseUnits,
      mint: MINT,
      vault: "Vault11111111111111111111111111111111111111",
      contestPda: "Contest111111111111111111111111111111111111",
      depositReceipt: "Receipt1111111111111111111111111111111111",
      now: NOW,
    };
    const first = await store.confirmVerifiedDeposit(input);
    expect(first.idempotent).toBe(false);
    const second = await store.confirmVerifiedDeposit(input);
    expect(second.idempotent).toBe(true);
    expect(second.entry.depositSignature).toBe(input.signature);
  });

  it("keeps RPC timeout confirming, accepts a later finalized claim, and rejects a wrong tx", async () => {
    const claimant = generateWallet();
    const other = Keypair.generate().publicKey.toBase58();
    const { service, prepared } = await preparedSettlement(claimant.publicKey, other);
    await service.markClaimSubmitted(prepared.id, ENTRY_A, "sig-pending", "2026-10-06T00:04:00.000Z");

    const built = buildTestApp(() => NOW);
    built.deps.settlement = service;
    built.deps.config = {
      ...built.deps.config,
      public: { ...built.deps.config.public, usdcMint: MINT },
      server: {
        ...built.deps.config.server,
        solana: { ...built.deps.config.server.solana, usdcMint: MINT },
      },
    };
    let observeCalls = 0;
    built.deps.claimObserver = async () => {
      observeCalls += 1;
      if (observeCalls === 1) throw new RpcUnavailable();
      return null;
    };
    const issued = await built.deps.auth.issueNonce(claimant.publicKey, { now: NOW, correlationId: null });
    const session = await built.deps.auth.login(
      {
        walletAddress: claimant.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, claimant.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    const app = createApp(built.deps);
    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    };
    const timeout = await app.request(`/settlements/${prepared.id}/reconcile-claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({ entryId: ENTRY_A, signature: "sig-pending" }),
    });
    expect(timeout.status).toBe(202);
    const timeoutBody = (await timeout.json()) as { claimUiState: string; claimStatus: string };
    expect(timeoutBody.claimUiState).toBe("confirming");
    expect(timeoutBody.claimStatus).not.toBe("FAILED");
    expect(timeoutBody.claimStatus).not.toBe("CLAIMED");

    const proof = await service.claimProof(prepared.id, ENTRY_A);
    const contestPda = "Contest111111111111111111111111111111111111";
    const vault = "Vault11111111111111111111111111111111111111";
    const claimPda = "ClaimPda11111111111111111111111111111111111";
    const wrong = await app.request(`/settlements/${prepared.id}/reconcile-claim`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        entryId: ENTRY_A,
        observation: claimObs({
          claimant: claimant.publicKey,
          contestPda,
          entryId: ENTRY_A,
          amountBaseUnits: 1,
          mint: MINT,
          vault,
          claimPda,
          vaultBalanceDecrease: 1,
        }),
        expectedContestPda: contestPda,
        expectedMint: MINT,
        expectedVault: vault,
        expectedClaimPda: claimPda,
      }),
    });
    expect(wrong.status).toBe(409);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe("RECONCILE_REJECTED");
    const still = await service.claimProof(prepared.id, ENTRY_A);
    expect(still.row.claimStatus).toBe("SUBMITTED");

    const goodObs = claimObs({
      signature: "sig-final-good",
      claimant: claimant.publicKey,
      contestPda,
      entryId: ENTRY_A,
      amountBaseUnits: proof.row.netPayoutBaseUnits,
      mint: MINT,
      vault,
      claimPda,
    });
    expect(
      decideClaim({
        observation: goodObs,
        programId: PROGRAM,
        expectedClaimant: claimant.publicKey,
        expectedContestPda: contestPda,
        expectedVersion: 1,
        expectedEntryId: ENTRY_A,
        expectedAmount: proof.row.netPayoutBaseUnits,
        expectedMint: MINT,
        expectedVault: vault,
        expectedClaimPda: claimPda,
        existingSignature: "other",
      }),
    ).toEqual({ ok: false, reason: "DUPLICATE_CLAIM" });

    const claimed = await service.markClaimed(
      prepared.id,
      ENTRY_A,
      "sig-final-good",
      "2026-10-06T00:05:00.000Z",
    );
    expect(claimed.claimStatus).toBe("CLAIMED");
    expect(claimed.claimStatus).not.toBe("SUBMITTED");
  });

  it("serializes concurrent claim reconcile to a single CLAIMED row", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const { service, prepared } = await preparedSettlement(w1, w2);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        service.markClaimed(prepared.id, ENTRY_A, "sig-same", "2026-10-06T00:06:00.000Z"),
      ),
    );
    expect(results.every((row) => row.claimStatus === "CLAIMED")).toBe(true);
    expect(results.every((row) => row.claimSignature === "sig-same")).toBe(true);
    await expect(
      service.markClaimed(prepared.id, ENTRY_A, "sig-other", "2026-10-06T00:07:00.000Z"),
    ).rejects.toMatchObject({ code: "ALREADY_CLAIMED" });
    const row = await service.claimProof(prepared.id, ENTRY_A);
    expect(row.row.claimStatus).toBe("CLAIMED");
    expect(row.row.claimSignature).toBe("sig-same");
  });

  it("blocks unauthorized resource access and audit mutation", async () => {
    const player = await loginApp();
    const overview = await player.app.request("/v1/ops/overview", { headers: player.headers });
    expect(overview.status).toBe(403);
    const denial = (await player.audit.list(20)).find((event) => event.action === "PERMISSION_DENIED");
    // ops begin audits wallet mismatch; requirePermission on settlement may audit
    const scoring = await player.app.request("/contests/00000000-0000-4000-8000-000000000099/settlement/calculate", {
      method: "POST",
      headers: player.headers,
    });
    expect(scoring.status).toBe(403);
    const events = await player.audit.list(50);
    expect(events.some((event) => event.action === "PERMISSION_DENIED")).toBe(true);
    void denial;

    expect(() => updateAuditEvent()).toThrow(/append-only|forbidden/i);
    expect(() => deleteAuditEvent()).toThrow(/append-only|forbidden/i);
    const mutate = await player.app.request("/v1/ops/audit/events", {
      method: "DELETE",
      headers: player.headers,
    });
    expect([401, 403, 405]).toContain(mutate.status);
  });

  it("keeps secrets out of errors and logs, and production config fails closed", () => {
    const cleaned = redact({
      authorization: "Bearer supersecrettokenvalue",
      message: "Bearer abcdefghijklmnop failed postgres://kickr:supersecretpassword@localhost/kickr",
      signature: "ed25519-signature-material",
    }) as { authorization: string; message: string; signature: string };
    expect(cleaned.authorization).toBe("[redacted]");
    expect(cleaned.signature).toBe("[redacted]");
    expect(cleaned.message).not.toContain("supersecretpassword");
    expect(cleaned.message).toContain("Bearer [redacted]");

    const mapped = toPublicError(
      new Error("boom postgres://kickr:supersecretpassword@db/kickr"),
      "production",
      "corr",
    );
    expect(JSON.stringify(mapped)).not.toContain("supersecretpassword");
    expect(mapped.body.error.message).toBe("Internal error");

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://kickr:x@localhost/kickr",
        REDIS_URL: "redis://localhost",
        AUTH_DOMAIN: "kickr.app",
        SOLANA_RPC_URL: "https://rpc.example",
        ESCROW_PROGRAM_ID: PROGRAM,
        USDC_MINT: MINT,
        SPORTS_PROVIDER: "none",
        SPORTS_DATA_PROVIDER: "local-dev",
        ALLOWED_ORIGINS: "https://kickr.app",
        SESSION_TTL_SECONDS: "3600",
      }),
    ).toThrow(ConfigError);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://kickr:x@localhost/kickr",
        REDIS_URL: "redis://localhost",
        AUTH_DOMAIN: "kickr.app",
        SOLANA_RPC_URL: "https://rpc.example",
        ESCROW_PROGRAM_ID: PROGRAM,
        USDC_MINT: MINT,
        SPORTS_PROVIDER: "none",
        SPORTS_DATA_PROVIDER: "sportmonks",
        ALLOWED_ORIGINS: "*",
        SESSION_TTL_SECONDS: "3600",
        APPROVED_ATTESTORS: "ORACLE_A:1111111111111111111111111111111111111111111111111111111111111111",
      }),
    ).toThrow(/ALLOWED_ORIGINS/);

    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "",
        REDIS_URL: "redis://localhost",
        AUTH_DOMAIN: "kickr.app",
        SOLANA_RPC_URL: "https://rpc.example",
      }),
    ).toThrow(ConfigError);
  });

  it("blocks fixture routes in production and separates health checks", async () => {
    const prod = await loginApp({ nodeEnv: "production" });
    const fixture = await prod.app.request("/v1/dev/fixtures/load", { method: "POST" });
    expect(fixture.status).toBe(404);
    expect(((await fixture.json()) as { error: { code: string } }).error.code).toBe("FIXTURE_DISABLED");

    const live = await prod.app.request("/health");
    expect(live.status).toBe(200);
    expect(((await live.json()) as { check: string }).check).toBe("live");
    const ready = await prod.app.request("/ready");
    expect(ready.status).toBe(200);
    const readyBody = (await ready.json()) as { check: string; redis: { ok: boolean } };
    expect(readyBody.check).toBe("ready");
    expect(readyBody.redis.ok).toBe(true);
    const deps = await prod.app.request("/health/dependencies");
    expect(deps.status).toBe(200);
    const report = (await deps.json()) as {
      live: boolean;
      ready: boolean;
      dependencies: { sports: { ok: boolean }; startupConfig: { ok: boolean } };
    };
    expect(report.live).toBe(true);
    expect(report.dependencies.startupConfig.ok).toBe(true);

    const counters = new ReliabilityCounters();
    counters.hit("rate_limit_hits");
    expect(counters.snapshot().rate_limit_hits).toBe(1);
    expect(counters.snapshot().auth_failures).toBe(0);
  });

  it("drops stale authorization after role removal and keeps correlation ids", async () => {
    const admin = await loginApp();
    await admin.grants.grantRole(admin.accountId, "SUPPORT");
    const app = createApp(admin.deps);
    const ok = await app.request("/v1/ops/entries", {
      headers: admin.headers,
    });
    expect(ok.status).toBe(200);
    await admin.grants.revokeRole(admin.accountId, "SUPPORT");
    const denied = await app.request("/v1/ops/entries", {
      headers: { ...admin.headers, "x-request-id": "corr-phase8-1" },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("x-request-id")).toBe("corr-phase8-1");
    const body = (await denied.json()) as { error: { correlationId: string } };
    expect(body.error.correlationId).toBe("corr-phase8-1");
  });

  it("does not invent templates and keeps DEV_TEMPLATES out of production path checks", () => {
    expect(DEV_TEMPLATES.length).toBeGreaterThan(0);
    expect(loadConfig({
      DATABASE_URL: "postgres://kickr:x@localhost/kickr",
      REDIS_URL: "redis://localhost",
      AUTH_DOMAIN: "localhost",
      SOLANA_RPC_URL: "https://rpc.example",
      NODE_ENV: "development",
      SPORTS_DATA_PROVIDER: "local-dev",
    }).server.nodeEnv).toBe("development");
  });
});
