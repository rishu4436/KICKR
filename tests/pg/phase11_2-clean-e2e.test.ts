/**
 * Phase 11.2 clean FREE E2E on Postgres — zero manual DB edits, forward-only lifecycle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  advanceMatchAlongPath,
  appendLateLocalDevEvents,
  finalizeFreeFromLiveScores,
  rebuildLiveScores,
  seedFreshLocalDevMatch,
} from "../../contests/free/dev-e2e-harness.js";
import { assertFreeDevHarnessAllowed, isFreeDevHarnessAllowed } from "../../contests/free/dev-gate.js";
import { pickDiverseLocalDevXi } from "../../sports/local-dev-provider.js";
import { AppError } from "../../shared/errors.js";
import {
  buildPgApp,
  loginPg,
  requireTestDatabaseUrl,
  resetTestDatabase,
} from "./harness.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");

describe("Phase 11.2 clean FREE E2E (Postgres)", () => {
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
    ctx.deps.scoringActors?.clear();
  }, 60_000);

  it("proves the harness is blocked in production", () => {
    expect(isFreeDevHarnessAllowed({ nodeEnv: "production", sportsDataProvider: "local-dev" })).toBe(
      false,
    );
    expect(() =>
      assertFreeDevHarnessAllowed({ nodeEnv: "production", sportsDataProvider: "local-dev" }),
    ).toThrow(AppError);
    const res = ctx.app.request;
    void res;
  });

  it("runs create → XI → join → LIVE score → FINAL finalize with no SQL edits", async () => {
    const e2e = {
      nodeEnv: ctx.deps.config.server.nodeEnv,
      sportsDataProvider: ctx.deps.config.public.sportsDataProvider,
      football: ctx.deps.football,
      footballStore: ctx.footballStore,
      contests: ctx.deps.contests,
      live: ctx.deps.live!,
      audit: ctx.deps.audit,
      scoringActors: ctx.deps.scoringActors!,
      clock: () => NOW,
    };

    const main = await loginPg(ctx.app, NOW);
    await e2e.scoringActors.register(main.accountId, { now: NOW, correlationId: "pg-e2e" });

    const seeded = await seedFreshLocalDevMatch(e2e, 0x11_2e2e);
    expect(seeded.status).toBe("LINEUPS_AVAILABLE");

    // HTTP gate: create match via route
    const httpSeed = await ctx.app.request("/v1/dev/e2e/matches", {
      method: "POST",
      headers: main.headers,
      body: JSON.stringify({ seed: 0x22_2e2e }),
    });
    expect(httpSeed.status).toBe(201);

    await ctx.deps.contests.listDiscoverable(seeded.matchId, { now: NOW, correlationId: null });
    const listed = await ctx.deps.contests.listDiscoverable(seeded.matchId, {
      now: NOW,
      correlationId: null,
    });
    const grand = listed.find((c) => c.templateCode === "FREE-GRAND");
    expect(grand).toBeTruthy();

    const users = [main];
    for (let i = 0; i < 3; i += 1) {
      if (i > 0) users.push(await loginPg(ctx.app, NOW));
    }

    const joins = [];
    for (let i = 0; i < users.length; i += 1) {
      const user = users[i]!;
      const poolRes = await ctx.app.request(`/matches/${seeded.matchId}/players`, { headers: user.headers });
      const pool = (await poolRes.json()) as {
        players: Array<{ playerId: string; position: string; clubId: string; shortName?: string }>;
      };
      const draft = pickDiverseLocalDevXi(pool.players, i);
      const teamRes = await ctx.app.request("/teams", {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify({ matchId: seeded.matchId }),
      });
      expect(teamRes.status).toBe(201);
      const team = (await teamRes.json()) as { team: { id: string } };
      const verRes = await ctx.app.request(`/teams/${team.team.id}/versions`, {
        method: "POST",
        headers: user.headers,
        body: JSON.stringify(draft),
      });
      expect(verRes.status).toBe(201);
      const ver = (await verRes.json()) as { version: { id: string } };

      const myTeam = await ctx.app.request(`/matches/${seeded.matchId}/my-team`, { headers: user.headers });
      const myBody = (await myTeam.json()) as {
        latest: { id: string; captainId: string; viceId: string };
      };
      expect(myBody.latest.id).toBe(ver.version.id);
      expect(myBody.latest.captainId).toBe(draft.captainId);
      expect(myBody.latest.viceId).toBe(draft.viceId);

      const joinRes = await ctx.app.request(`/contests/${grand!.contestId}/free-join`, {
        method: "POST",
        headers: { ...user.headers, "idempotency-key": `pg-e2e-${user.accountId}` },
        body: JSON.stringify({ teamVersionId: ver.version.id }),
      });
      expect(joinRes.status).toBe(201);
      const joined = (await joinRes.json()) as { entry: { id: string } };
      joins.push(joined.entry.id);
    }

    const mineUp = await ctx.app.request("/me/contests", { headers: main.headers });
    const upBody = (await mineUp.json()) as {
      contests: Array<{ contestId: string; lifecycleBucket: string }>;
    };
    expect(upBody.contests.find((c) => c.contestId === grand!.contestId)?.lifecycleBucket).toBe(
      "upcoming",
    );

    await advanceMatchAlongPath(e2e, seeded.matchId, "LIVE");
    const wave1 = await rebuildLiveScores(e2e, seeded.matchId);
    const board1 = wave1.leaderboard
      .filter((r) => r.contestId === grand!.contestId)
      .sort((a, b) => a.rank - b.rank);
    expect(board1.length).toBe(joins.length);
    expect(new Set(board1.map((r) => r.milliPoints)).size).toBeGreaterThanOrEqual(2);

    await appendLateLocalDevEvents(e2e, seeded.matchId);
    const wave2 = await rebuildLiveScores(e2e, seeded.matchId);
    const board2 = wave2.leaderboard
      .filter((r) => r.contestId === grand!.contestId)
      .sort((a, b) => a.rank - b.rank);
    expect(board2.some((r, i) => r.milliPoints !== board1[i]?.milliPoints || r.entryId !== board1[i]?.entryId)).toBe(
      true,
    );

    const mineLive = await ctx.app.request("/me/contests", { headers: main.headers });
    const liveBody = (await mineLive.json()) as {
      contests: Array<{ contestId: string; lifecycleBucket: string }>;
    };
    expect(liveBody.contests.find((c) => c.contestId === grand!.contestId)?.lifecycleBucket).toBe("live");

    await advanceMatchAlongPath(e2e, seeded.matchId, "FINAL");
    await rebuildLiveScores(e2e, seeded.matchId);
    const finalized = await finalizeFreeFromLiveScores(e2e, grand!.contestId, main.accountId);
    expect(finalized.status).toBe("FINAL");
    expect(finalized.rows.length).toBe(joins.length);
    expect(finalized.claimable).toBe(false);
    expect(finalized.merkleRoot).toBeNull();

    const mineDone = await ctx.app.request("/me/contests", { headers: main.headers });
    const doneBody = (await mineDone.json()) as {
      contests: Array<{ contestId: string; lifecycleBucket: string; primaryCta: string }>;
    };
    const done = doneBody.contests.find((c) => c.contestId === grand!.contestId);
    expect(done?.lifecycleBucket).toBe("completed");
    expect(done?.primaryCta).toBe("view_result");

    const resultRes = await ctx.app.request(`/contests/${grand!.contestId}/my-result`, {
      headers: main.headers,
    });
    expect(resultRes.status).toBe(200);
    const result = (await resultRes.json()) as {
      contestKind: string;
      claimable: boolean;
      xiSummary: unknown[];
      captainId: string | null;
      viceId: string | null;
      topLeaderboard: unknown[];
      monetaryPrize: boolean;
      rank: number;
    };
    expect(result.contestKind).toBe("FREE");
    expect(result.claimable).toBe(false);
    expect(result.monetaryPrize).toBe(false);
    expect(result.xiSummary.length).toBe(11);
    expect(result.captainId).toBeTruthy();
    expect(result.viceId).toBeTruthy();
    expect(result.topLeaderboard.length).toBeGreaterThanOrEqual(1);
    expect(result.rank).toBeGreaterThanOrEqual(1);
  }, 120_000);
});
