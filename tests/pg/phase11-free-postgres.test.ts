/**
 * Phase 11.1 Postgres integration tests.
 * Run via: npm run test:pg
 * Requires KICKR_TEST_DATABASE_URL (or DATABASE_URL → kickr_test).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  classifyContestLifecycle,
  contestPrimaryCta,
} from "../../domain/football/presentation.js";
import { FREE_TEMPLATE_IDS } from "../../contests/free/catalog.js";
import { isFreeContest, rejectFreeMoneyPath } from "../../contests/kind.js";
import {
  LOCAL_DEV_MATCH_FINAL,
  LOCAL_DEV_MATCH_LIVE,
  LOCAL_DEV_MATCH_UPCOMING,
} from "../../sports/local-dev-provider.js";
import {
  buildPgApp,
  loginPg,
  requireTestDatabaseUrl,
  resetTestDatabase,
  saveXiViaApi,
} from "./harness.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");

describe("Phase 11.1 Postgres FREE contest flow", () => {
  let ctx: Awaited<ReturnType<typeof buildPgApp>>;

  beforeAll(async () => {
    requireTestDatabaseUrl();
    ctx = await buildPgApp(() => NOW);
  }, 120_000);

  afterAll(async () => {
    await ctx?.close();
  });

  beforeEach(async () => {
    await resetTestDatabase(ctx.pool);
    const { createLocalDevProvider } = await import("../../sports/local-dev-provider.js");
    await ctx.footballStore.upsertCatalog(createLocalDevProvider().catalog());
  }, 60_000);

  it("loads final FREE results from Postgres without Date mapping crashes", async () => {
    const user = await loginPg(ctx.app, NOW);
    await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_FINAL, { now: NOW, correlationId: null });
    // FINAL match blocks XI — open temporarily via store transition path is illegal; use SQL status for XI only.
    await ctx.pool.query(`UPDATE matches SET status = 'LINEUPS_AVAILABLE' WHERE id = $1`, [LOCAL_DEV_MATCH_FINAL]);
    const xi = await saveXiViaApi(ctx.app, user.headers, LOCAL_DEV_MATCH_FINAL, 0);
    const contests = await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_FINAL, {
      now: NOW,
      correlationId: null,
    });
    const grand = contests.find((c) => c.templateCode === "FREE-GRAND");
    expect(grand).toBeTruthy();
    const joined = await ctx.deps.contests.joinFree(
      grand!.contestId,
      user.accountId,
      user.wallet.publicKey,
      xi.versionId,
      { now: NOW, correlationId: null },
    );
    await ctx.pool.query(`UPDATE matches SET status = 'FINAL' WHERE id = $1`, [LOCAL_DEV_MATCH_FINAL]);
    await ctx.deps.contests.finalizeFreeResult(
      grand!.contestId,
      [
        {
          entryId: joined.entry.id,
          wallet: user.wallet.publicKey,
          teamVersionId: xi.versionId,
          finalScoreMilliPoints: 12500,
        },
      ],
      { now: NOW, correlationId: null },
    );

    const freeRes = await ctx.app.request(`/contests/${grand!.contestId}/free-result`, {
      headers: user.headers,
    });
    expect(freeRes.status).toBe(200);
    const freeBody = (await freeRes.json()) as {
      status: string;
      result: { finalizedAt: string; rows: Array<{ rank: number; finalScoreMilliPoints: number }> };
    };
    expect(freeBody.status).toBe("FINAL");
    expect(freeBody.result.rows[0]?.rank).toBe(1);
    expect(freeBody.result.rows[0]?.finalScoreMilliPoints).toBe(12500);
    expect(typeof freeBody.result.finalizedAt).toBe("string");
    expect(Number.isNaN(Date.parse(freeBody.result.finalizedAt))).toBe(false);

    const myRes = await ctx.app.request(`/contests/${grand!.contestId}/my-result`, {
      headers: user.headers,
    });
    expect(myRes.status).toBe(200);
    const myBody = (await myRes.json()) as {
      contestKind: string;
      rank: number;
      finalScoreMilliPoints: number;
      claimPlan: unknown;
      claimable: boolean;
    };
    expect(myBody.contestKind).toBe("FREE");
    expect(myBody.rank).toBe(1);
    expect(myBody.finalScoreMilliPoints).toBe(12500);
    expect(myBody.claimPlan).toBeNull();
    expect(myBody.claimable).toBe(false);
  });

  it("accepts second and third FREE-GRAND joins and rejects H2H overflow", async () => {
    const users = [await loginPg(ctx.app, NOW), await loginPg(ctx.app, NOW), await loginPg(ctx.app, NOW)];
    await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const listed = await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, {
      now: NOW,
      correlationId: null,
    });
    const grand = listed.find((c) => c.templateId === FREE_TEMPLATE_IDS.GRAND);
    const h2h = listed.find((c) => c.templateId === FREE_TEMPLATE_IDS.H2H);
    expect(grand && h2h).toBeTruthy();

    const versions: Array<Awaited<ReturnType<typeof saveXiViaApi>>> = [];
    for (let i = 0; i < 3; i += 1) {
      versions.push(await saveXiViaApi(ctx.app, users[i]!.headers, LOCAL_DEV_MATCH_UPCOMING, i));
    }

    const j1 = await ctx.app.request(`/contests/${grand!.contestId}/free-join`, {
      method: "POST",
      headers: { ...users[0]!.headers, "idempotency-key": "pg-grand-1" },
      body: JSON.stringify({ teamVersionId: versions[0]!.versionId }),
    });
    expect(j1.status).toBe(201);
    const j2 = await ctx.app.request(`/contests/${grand!.contestId}/free-join`, {
      method: "POST",
      headers: { ...users[1]!.headers, "idempotency-key": "pg-grand-2" },
      body: JSON.stringify({ teamVersionId: versions[1]!.versionId }),
    });
    expect(j2.status).toBe(201);
    const j3 = await ctx.app.request(`/contests/${grand!.contestId}/free-join`, {
      method: "POST",
      headers: { ...users[2]!.headers, "idempotency-key": "pg-grand-3" },
      body: JSON.stringify({ teamVersionId: versions[2]!.versionId }),
    });
    expect(j3.status).toBe(201);
    const body3 = (await j3.json()) as { contest: { filledCount: number; status: string } };
    expect(body3.contest.filledCount).toBe(3);
    expect(body3.contest.status).toBe("PARTIALLY_FILLED");

    const h1 = await ctx.app.request(`/contests/${h2h!.contestId}/free-join`, {
      method: "POST",
      headers: { ...users[0]!.headers, "idempotency-key": "pg-h2h-1" },
      body: JSON.stringify({ teamVersionId: versions[0]!.versionId }),
    });
    expect(h1.status).toBe(201);
    const h2 = await ctx.app.request(`/contests/${h2h!.contestId}/free-join`, {
      method: "POST",
      headers: { ...users[1]!.headers, "idempotency-key": "pg-h2h-2" },
      body: JSON.stringify({ teamVersionId: versions[1]!.versionId }),
    });
    expect(h2.status).toBe(201);
    const h2Body = (await h2.json()) as { contest: { filledCount: number; status: string }; nextContest?: { contestId: string } | null };
    expect(h2Body.contest.filledCount).toBe(2);
    expect(h2Body.contest.status).toBe("FULL");

    // Third join must target the full room (not the spawned next room).
    const h3 = await ctx.app.request(`/contests/${h2h!.contestId}/free-join`, {
      method: "POST",
      headers: { ...users[2]!.headers, "idempotency-key": "pg-h2h-3" },
      body: JSON.stringify({ teamVersionId: versions[2]!.versionId }),
    });
    expect(h3.status).toBe(409);
    const h3Body = (await h3.json()) as { error?: { code?: string }; code?: string };
    const code = h3Body.error?.code ?? h3Body.code;
    expect(code === "CONTEST_FULL" || code === "CONTEST_NOT_JOINABLE").toBe(true);
  });

  it("handles concurrent FREE-GRAND joins without illegal self-transition", async () => {
    const users = await Promise.all([loginPg(ctx.app, NOW), loginPg(ctx.app, NOW), loginPg(ctx.app, NOW), loginPg(ctx.app, NOW)]);
    await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const listed = await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, {
      now: NOW,
      correlationId: null,
    });
    const grand = listed.find((c) => c.templateCode === "FREE-GRAND");
    expect(grand).toBeTruthy();
    const versions: Array<Awaited<ReturnType<typeof saveXiViaApi>>> = [];
    for (let i = 0; i < users.length; i += 1) {
      versions.push(await saveXiViaApi(ctx.app, users[i]!.headers, LOCAL_DEV_MATCH_UPCOMING, i));
    }
    // Seed first seat so contest is already PARTIALLY_FILLED before the race.
    const first = await ctx.app.request(`/contests/${grand!.contestId}/free-join`, {
      method: "POST",
      headers: { ...users[0]!.headers, "idempotency-key": "pg-race-0" },
      body: JSON.stringify({ teamVersionId: versions[0]!.versionId }),
    });
    expect(first.status).toBe(201);

    const raced = await Promise.all(
      users.slice(1).map((user, index) =>
        ctx.app.request(`/contests/${grand!.contestId}/free-join`, {
          method: "POST",
          headers: { ...user.headers, "idempotency-key": `pg-race-${index + 1}` },
          body: JSON.stringify({ teamVersionId: versions[index + 1]!.versionId }),
        }),
      ),
    );
    const statuses = raced.map((r) => r.status);
    expect(statuses.every((s) => s === 201 || s === 409)).toBe(true);
    expect(statuses.filter((s) => s === 201).length).toBeGreaterThanOrEqual(2);
    for (const res of raced) {
      if (!res.ok) {
        const body = (await res.json()) as { error?: { code?: string; message?: string }; message?: string };
        const msg = JSON.stringify(body);
        expect(msg).not.toMatch(/ILLEGAL_TRANSITION/);
        expect(msg).not.toMatch(/PARTIALLY_FILLED -> PARTIALLY_FILLED/);
      }
    }
    const contest = await ctx.deps.contests.getContest(grand!.contestId);
    expect(contest.filledCount).toBeGreaterThanOrEqual(3);
    expect(["PARTIALLY_FILLED", "FULL"]).toContain(contest.status);
  });

  it("classifies My Contests lifecycle and result CTAs mutually exclusively", async () => {
    expect(classifyContestLifecycle({ matchStatus: "LINEUPS_AVAILABLE" })).toBe("upcoming");
    expect(classifyContestLifecycle({ matchStatus: "LOCKED" })).toBe("upcoming");
    expect(classifyContestLifecycle({ matchStatus: "LIVE" })).toBe("live");
    expect(classifyContestLifecycle({ matchStatus: "HALFTIME" })).toBe("live");
    expect(classifyContestLifecycle({ matchStatus: "FINAL" })).toBe("completed");
    expect(classifyContestLifecycle({ matchStatus: "LIVE", hasFinalResult: true })).toBe("completed");
    expect(contestPrimaryCta("upcoming")).toBe("view_contest");
    expect(contestPrimaryCta("live")).toBe("live_leaderboard");
    expect(contestPrimaryCta("completed")).toBe("view_result");

    const user = await loginPg(ctx.app, NOW);
    // Upcoming join
    await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const upXi = await saveXiViaApi(ctx.app, user.headers, LOCAL_DEV_MATCH_UPCOMING, 0);
    const upList = await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, {
      now: NOW,
      correlationId: null,
    });
    const upGrand = upList.find((c) => c.templateCode === "FREE-GRAND")!;
    await ctx.deps.contests.joinFree(upGrand.contestId, user.accountId, user.wallet.publicKey, upXi.versionId, {
      now: NOW,
      correlationId: null,
    });

    // Live join (open XI temporarily)
    await ctx.pool.query(`UPDATE matches SET status = 'LINEUPS_AVAILABLE' WHERE id = $1`, [LOCAL_DEV_MATCH_LIVE]);
    const liveXi = await saveXiViaApi(ctx.app, user.headers, LOCAL_DEV_MATCH_LIVE, 1);
    const liveList = await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_LIVE, {
      now: NOW,
      correlationId: null,
    });
    const liveGrand = liveList.find((c) => c.templateCode === "FREE-GRAND")!;
    await ctx.deps.contests.joinFree(liveGrand.contestId, user.accountId, user.wallet.publicKey, liveXi.versionId, {
      now: NOW,
      correlationId: null,
    });
    await ctx.pool.query(`UPDATE matches SET status = 'LIVE' WHERE id = $1`, [LOCAL_DEV_MATCH_LIVE]);
    await ctx.deps.contests.lockContestsForMatch(LOCAL_DEV_MATCH_LIVE, { now: NOW, correlationId: null });

    // Final + result
    await ctx.pool.query(`UPDATE matches SET status = 'LINEUPS_AVAILABLE' WHERE id = $1`, [LOCAL_DEV_MATCH_FINAL]);
    const finalXi = await saveXiViaApi(ctx.app, user.headers, LOCAL_DEV_MATCH_FINAL, 2);
    const finalList = await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_FINAL, {
      now: NOW,
      correlationId: null,
    });
    const finalGrand = finalList.find((c) => c.templateCode === "FREE-GRAND")!;
    const finalJoin = await ctx.deps.contests.joinFree(
      finalGrand.contestId,
      user.accountId,
      user.wallet.publicKey,
      finalXi.versionId,
      { now: NOW, correlationId: null },
    );
    await ctx.pool.query(`UPDATE matches SET status = 'FINAL' WHERE id = $1`, [LOCAL_DEV_MATCH_FINAL]);
    await ctx.deps.contests.finalizeFreeResult(
      finalGrand.contestId,
      [
        {
          entryId: finalJoin.entry.id,
          wallet: user.wallet.publicKey,
          teamVersionId: finalXi.versionId,
          finalScoreMilliPoints: 9000,
        },
      ],
      { now: NOW, correlationId: null },
    );

    const mine = await ctx.app.request("/me/contests", { headers: user.headers });
    expect(mine.status).toBe(200);
    const mineBody = (await mine.json()) as {
      contests: Array<{
        contestId: string;
        lifecycleBucket: string;
        primaryCta: string;
        status: string;
        matchStatus: string | null;
      }>;
    };
    const byId = new Map(mineBody.contests.map((c) => [c.contestId, c]));
    expect(byId.get(upGrand.contestId)?.lifecycleBucket).toBe("upcoming");
    expect(byId.get(upGrand.contestId)?.primaryCta).toBe("view_contest");
    expect(byId.get(liveGrand.contestId)?.lifecycleBucket).toBe("live");
    expect(byId.get(liveGrand.contestId)?.primaryCta).toBe("live_leaderboard");
    // LOCKED contest status must not force completed
    expect(byId.get(liveGrand.contestId)?.status).toBe("LOCKED");
    expect(byId.get(liveGrand.contestId)?.lifecycleBucket).not.toBe("completed");
    expect(byId.get(finalGrand.contestId)?.lifecycleBucket).toBe("completed");
    expect(byId.get(finalGrand.contestId)?.primaryCta).toBe("view_result");

    const buckets = mineBody.contests.map((c) => c.lifecycleBucket);
    // Mutual exclusivity: each contest appears in exactly one bucket.
    expect(new Set(mineBody.contests.map((c) => c.contestId)).size).toBe(mineBody.contests.length);
    expect(buckets.filter((b) => b === "upcoming").length).toBeGreaterThanOrEqual(1);
    expect(buckets.filter((b) => b === "live").length).toBeGreaterThanOrEqual(1);
    expect(buckets.filter((b) => b === "completed").length).toBeGreaterThanOrEqual(1);
  });

  it("keeps FREE money-path isolation on Postgres-backed contests", async () => {
    const user = await loginPg(ctx.app, NOW);
    await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const xi = await saveXiViaApi(ctx.app, user.headers, LOCAL_DEV_MATCH_UPCOMING, 0);
    const listed = await ctx.deps.contests.listDiscoverable(LOCAL_DEV_MATCH_UPCOMING, {
      now: NOW,
      correlationId: null,
    });
    const free = listed.find((c) => c.contestKind === "FREE" && c.templateCode === "FREE-H2H")!;
    expect(isFreeContest(free)).toBe(true);
    expect(() => rejectFreeMoneyPath(free, "reservation-with-deposit")).toThrow();

    const reserve = await ctx.app.request(`/contests/${free.contestId}/reservations`, {
      method: "POST",
      headers: { ...user.headers, "idempotency-key": "pg-money-reserve" },
      body: JSON.stringify({ teamVersionId: xi.versionId }),
    });
    expect(reserve.status).toBeGreaterThanOrEqual(400);

    const joined = await ctx.app.request(`/contests/${free.contestId}/free-join`, {
      method: "POST",
      headers: { ...user.headers, "idempotency-key": "pg-money-free" },
      body: JSON.stringify({ teamVersionId: xi.versionId }),
    });
    expect(joined.status).toBe(201);
    const body = (await joined.json()) as { payment: string; confirmed: boolean; depositPlan: unknown };
    expect(body.payment).toBe("FREE_NO_PAYMENT");
    expect(body.confirmed).toBe(true);
    expect(body.depositPlan).toBeNull();
  });
});
