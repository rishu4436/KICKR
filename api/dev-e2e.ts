/**
 * Dev-only FREE E2E HTTP surface. Refuses in production / non-local-dev.
 * Never grants RUN_SETTLEMENT. Scoring actor is harness-local, audited.
 */
import type { Context, Hono } from "hono";
import type { Principal } from "../auth/types.js";
import {
  advanceMatchAlongPath,
  advanceMatchForward,
  appendLateLocalDevEvents,
  finalizeFreeFromLiveScores,
  rebuildLiveScores,
  seedFreshLocalDevMatch,
  type DevE2eDeps,
} from "../contests/free/dev-e2e-harness.js";
import { assertFreeDevHarnessAllowed } from "../contests/free/dev-gate.js";
import type { MatchState } from "../domain/state-machine.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";

function e2eDeps(deps: AppDeps): DevE2eDeps {
  if (!deps.live) {
    throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
  }
  if (!deps.scoringActors) {
    throw new AppError("NOT_FOUND", 404, "Local-dev scoring actor registry is not available");
  }
  if (!deps.footballStore) {
    throw new AppError("NOT_FOUND", 404, "Football store is not available");
  }
  return {
    nodeEnv: deps.config.server.nodeEnv,
    sportsDataProvider: deps.config.public.sportsDataProvider,
    football: deps.football,
    footballStore: deps.footballStore,
    contests: deps.contests,
    live: deps.live,
    audit: deps.audit,
    scoringActors: deps.scoringActors,
    clock: deps.clock,
  };
}

function gate(deps: AppDeps): void {
  assertFreeDevHarnessAllowed({
    nodeEnv: deps.config.server.nodeEnv,
    sportsDataProvider: deps.config.public.sportsDataProvider,
  });
}

export function registerDevE2eRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.post("/v1/dev/e2e/matches", async (c) => {
    gate(deps);
    await authenticate(c);
    const body = (await c.req.json().catch(() => ({}))) as { seed?: number };
    const seeded = await seedFreshLocalDevMatch(e2eDeps(deps), body.seed);
    return c.json(seeded, 201);
  });

  app.post("/v1/dev/e2e/matches/:id/advance", async (c) => {
    gate(deps);
    await authenticate(c);
    const body = (await c.req.json().catch(() => ({}))) as { to?: string; until?: string };
    const matchId = c.req.param("id");
    if (body.until) {
      const result = await advanceMatchAlongPath(e2eDeps(deps), matchId, body.until as MatchState);
      return c.json(result);
    }
    if (!body.to) {
      throw new AppError("VALIDATION", 400, "to or until required");
    }
    const result = await advanceMatchForward(e2eDeps(deps), matchId, body.to as MatchState);
    return c.json(result);
  });

  app.post("/v1/dev/e2e/matches/:id/score", async (c) => {
    gate(deps);
    await authenticate(c);
    const result = await rebuildLiveScores(e2eDeps(deps), c.req.param("id"));
    return c.json(result);
  });

  app.post("/v1/dev/e2e/matches/:id/append-late-events", async (c) => {
    gate(deps);
    await authenticate(c);
    const result = await appendLateLocalDevEvents(e2eDeps(deps), c.req.param("id"));
    return c.json(result);
  });

  app.post("/v1/dev/e2e/scoring-actor", async (c) => {
    gate(deps);
    const principal = await authenticate(c);
    const registry = deps.scoringActors;
    if (!registry) {
      throw new AppError("NOT_FOUND", 404, "Local-dev scoring actor registry is not available");
    }
    await registry.register(principal.accountId, {
      now: deps.clock(),
      correlationId: c.get("requestId") ?? null,
    });
    return c.json({
      accountId: principal.accountId,
      role: "LOCAL_DEV_SCORER",
      runSettlement: false,
      note: "Harness-only scoring actor. Not grantable via ops. Audited.",
    });
  });

  app.post("/v1/dev/e2e/contests/:id/finalize", async (c) => {
    gate(deps);
    const principal = await authenticate(c);
    const result = await finalizeFreeFromLiveScores(
      e2eDeps(deps),
      c.req.param("id"),
      principal.accountId,
    );
    return c.json({ result });
  });
}
