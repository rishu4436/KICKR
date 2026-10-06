/**
 * Token-gated DEMO match control API.
 * Disabled unless SPORTS_PROVIDER=DEMO and DEMO_CONTROL_TOKEN is configured.
 * Not part of the consumer player UI. Never grants RUN_SETTLEMENT.
 */
import type { Context, Hono } from "hono";
import {
  assertDemoControlToken,
  demoAdvanceMatchAlongPath,
  demoAdvanceMatchForward,
  demoFinalizeFreeContests,
  demoInjectScoringWave,
  demoRebuildScores,
  seedFreshDemoMatch,
  isDemoControlConfigured,
  type DemoControlDeps,
  type DemoControlGate,
} from "../sports/demo-control.js";
import type { MatchState } from "../domain/state-machine.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";

function gateOf(deps: AppDeps): DemoControlGate {
  return {
    sportsProvider: deps.config.public.sportsProvider,
    demoControlToken: deps.config.server.sportsData.demoControlToken,
  };
}

function controlDeps(deps: AppDeps): DemoControlDeps {
  if (!deps.live) {
    throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
  }
  if (!deps.footballStore) {
    throw new AppError("NOT_FOUND", 404, "Football store is not available");
  }
  return {
    football: deps.football,
    footballStore: deps.footballStore,
    contests: deps.contests,
    live: deps.live,
    audit: deps.audit,
    clock: deps.clock,
  };
}

function requireToken(deps: AppDeps, c: Context<AppEnv>): void {
  const provided =
    c.req.header("x-demo-control-token") ??
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ??
    null;
  assertDemoControlToken(gateOf(deps), provided);
}

export function registerDemoControlRoutes(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/v1/demo/control/status", (c) => {
    const configured = isDemoControlConfigured(gateOf(deps));
    return c.json({
      enabled: configured,
      sportsProvider: deps.config.public.sportsProvider,
      demoData: deps.config.public.demoData,
      runSettlement: false,
      note: configured
        ? "Present x-demo-control-token to advance DEMO matches / inject scoring waves."
        : "Disabled unless SPORTS_PROVIDER=DEMO and DEMO_CONTROL_TOKEN (>=16 chars) is set.",
    });
  });


  app.post("/v1/demo/control/matches", async (c) => {
    requireToken(deps, c);
    deps.counters?.hit("demo_control_actions");
    const body = (await c.req.json().catch(() => ({}))) as { seed?: number };
    const result = await seedFreshDemoMatch(controlDeps(deps), body.seed);
    deps.logger.info({ matchId: result.matchId, action: "demo_seed_match" }, "demo control seed match");
    return c.json(result, 201);
  });

  app.post("/v1/demo/control/matches/:id/advance", async (c) => {
    requireToken(deps, c);
    deps.counters?.hit("demo_control_actions");
    const body = (await c.req.json().catch(() => ({}))) as { to?: string; until?: string };
    const matchId = c.req.param("id");
    if (body.until) {
      const result = await demoAdvanceMatchAlongPath(
        controlDeps(deps),
        matchId,
        body.until as MatchState,
      );
      deps.logger.info(
        { matchId, status: result.status, steps: result.steps.length, action: "demo_advance" },
        "demo control advance",
      );
      return c.json(result);
    }
    if (!body.to) {
      throw new AppError("VALIDATION", 400, "to or until required");
    }
    const result = await demoAdvanceMatchForward(controlDeps(deps), matchId, body.to as MatchState);
    deps.logger.info({ matchId, status: result.status, action: "demo_advance" }, "demo control advance");
    return c.json(result);
  });

  app.post("/v1/demo/control/matches/:id/score", async (c) => {
    requireToken(deps, c);
    deps.counters?.hit("demo_control_actions");
    deps.counters?.hit("scoring_rebuilds");
    const result = await demoRebuildScores(controlDeps(deps), c.req.param("id"));
    deps.logger.info(
      { matchId: c.req.param("id"), rows: result.leaderboard.length, action: "demo_score" },
      "demo control score rebuild",
    );
    return c.json(result);
  });

  app.post("/v1/demo/control/matches/:id/scoring-wave", async (c) => {
    requireToken(deps, c);
    deps.counters?.hit("demo_control_actions");
    deps.counters?.hit("scoring_rebuilds");
    const inserted = await demoInjectScoringWave(controlDeps(deps), c.req.param("id"));
    const scored = await demoRebuildScores(controlDeps(deps), c.req.param("id"));
    deps.logger.info(
      {
        matchId: c.req.param("id"),
        inserted: inserted.inserted,
        rows: scored.leaderboard.length,
        action: "demo_scoring_wave",
      },
      "demo control scoring wave",
    );
    return c.json({ ...inserted, leaderboard: scored.leaderboard });
  });

  app.post("/v1/demo/control/matches/:id/finalize-free", async (c) => {
    requireToken(deps, c);
    deps.counters?.hit("demo_control_actions");
    const result = await demoFinalizeFreeContests(controlDeps(deps), c.req.param("id"));
    deps.logger.info(
      {
        matchId: c.req.param("id"),
        finalized: result.finalized.length,
        runSettlement: false,
        action: "demo_finalize_free",
      },
      "demo control free finalize",
    );
    return c.json(result);
  });
}
