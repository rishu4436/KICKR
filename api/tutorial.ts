/**
 * Player-facing Tutorial Match simulation API (Phase 18D.1).
 * Authenticated. DEMO / Tutorial Match only — never Sportmonks.
 */
import type { Context, Hono } from "hono";
import type { Principal } from "../auth/types.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";
import {
  getTutorialStatus,
  resetTutorialMatch,
  startTutorialSimulation,
  tickTutorialSimulation,
  type TutorialSimDeps,
} from "../sports/tutorial-simulation.js";
import { DEMO_PROVIDER_NAME } from "../sports/demo-provider.js";

function simDeps(deps: AppDeps): TutorialSimDeps {
  if (!deps.live) throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
  if (!deps.footballStore) throw new AppError("NOT_FOUND", 404, "Football store is not available");
  return {
    football: deps.football,
    footballStore: deps.footballStore,
    contests: deps.contests,
    live: deps.live,
    audit: deps.audit,
    redis: deps.redis ?? null,
    clock: deps.clock,
    environment: deps.config.public.environment,
  };
}

async function assertTutorialRouteAllowed(deps: AppDeps, matchId: string): Promise<void> {
  const appMode = deps.config.server.sportsData.appMode;
  if (appMode === "LIVE") {
    throw new AppError("TUTORIAL_REFUSED", 403, "Tutorial simulation unavailable in LIVE-only mode");
  }
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  if (match.dataSource.provider !== DEMO_PROVIDER_NAME) {
    throw new AppError(
      "TUTORIAL_REFUSED",
      403,
      "Sportmonks fixtures cannot invoke the tutorial simulator",
    );
  }
}

export function registerTutorialRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.get("/v1/tutorial/status", async (c) => {
    await authenticate(c);
    return c.json({
      enabled: deps.config.server.sportsData.appMode === "DEMO" || deps.config.server.sportsData.appMode === "DUAL",
      appMode: deps.config.public.appMode,
      dualMode: deps.config.public.dualMode,
      label: "Tutorial Match",
      badge: "SIMULATED",
      note: "Learn KICKR by playing through a complete simulated match.",
    });
  });

  app.get("/v1/tutorial/matches/:id", async (c) => {
    await authenticate(c);
    await assertTutorialRouteAllowed(deps, c.req.param("id"));
    const status = await getTutorialStatus(simDeps(deps), c.req.param("id"));
    return c.json(status);
  });

  app.post("/v1/tutorial/matches/:id/start", async (c) => {
    await authenticate(c);
    await assertTutorialRouteAllowed(deps, c.req.param("id"));
    const state = await startTutorialSimulation(simDeps(deps), c.req.param("id"));
    const status = await getTutorialStatus(simDeps(deps), c.req.param("id"));
    return c.json({ state, status });
  });

  app.post("/v1/tutorial/matches/:id/tick", async (c) => {
    await authenticate(c);
    await assertTutorialRouteAllowed(deps, c.req.param("id"));
    const state = await tickTutorialSimulation(simDeps(deps), c.req.param("id"));
    const status = await getTutorialStatus(simDeps(deps), c.req.param("id"));
    return c.json({ state, status });
  });

  app.post("/v1/tutorial/matches/:id/reset", async (c) => {
    await authenticate(c);
    await assertTutorialRouteAllowed(deps, c.req.param("id"));
    const result = await resetTutorialMatch(simDeps(deps), c.req.param("id"));
    return c.json({ ...result, simulated: true, tutorial: true });
  });
}
