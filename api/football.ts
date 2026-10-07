import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/types.js";
import { isPlayerRole } from "../domain/football/roles.js";
import type { AppEnv, AppDeps } from "./server.js";
import { AppError } from "../shared/errors.js";
import { resolveRequestMode, matchBelongsToMode } from "../sports/mode-filter.js";
import { buildDemoSingleMatchCatalog } from "../sports/demo-provider.js";

const uuidSchema = z.string().uuid();

const createTeamSchema = z.object({
  matchId: uuidSchema,
}).strict();

const saveVersionSchema = z.object({
  playerIds: z.array(uuidSchema).max(30),
  captainId: uuidSchema,
  viceId: uuidSchema,
}).strict();

export function registerFootballRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.get("/matches", async (c) => {
    await authenticate(c);
    const bucket = c.req.query("bucket");
    if (bucket !== undefined && bucket !== "upcoming" && bucket !== "live" && bucket !== "completed") {
      throw new AppError("VALIDATION", 400, "bucket must be upcoming, live, or completed");
    }
    let mode;
    try {
      mode = resolveRequestMode({
        appMode: deps.config.server.sportsData.appMode,
        clientMode: c.req.query("mode") ?? c.req.header("x-kickr-mode"),
      });
    } catch (error) {
      throw new AppError("VALIDATION", 400, error instanceof Error ? error.message : "Invalid mode");
    }
    let matches = await deps.football.listMatches(bucket, mode);
    const appMode = deps.config.server.sportsData.appMode;
    // Phase 18D: strict one-match exposure per mode (ignore leftover seed rows).
    if (mode === "DEMO" && (appMode === "DEMO" || appMode === "DUAL")) {
      const allowed = new Set(buildDemoSingleMatchCatalog().matches.map((m) => m.id));
      matches = matches.filter((m) => allowed.has(m.id));
    }
    if (mode === "LIVE" && (appMode === "LIVE" || appMode === "DUAL")) {
      const liveId = deps.config.server.sportsData.liveFixtureId;
      matches = matches.filter((m) => m.externalFixtureId === liveId);
    }
    return c.json({
      matches,
      mode: mode ?? null,
      creditCap: deps.football.rulesView().creditCap,
      maxPlayersFromOneTeam: deps.football.rulesView().maxPlayersFromOneTeam,
    });
  });

  app.get("/matches/:id/players", async (c) => {
    await authenticate(c);
    const position = c.req.query("position");
    const players = position
      ? await (async () => {
          if (!isPlayerRole(position)) {
            throw new AppError("VALIDATION", 400, "position must be GK, DEF, MID, or FWD");
          }
          return deps.football.playersByPosition(c.req.param("id"), position);
        })()
      : await deps.football.getPlayerPool(c.req.param("id"));
    if (!players) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json({ players });
  });

  app.get("/matches/:id/squad", async (c) => {
    await authenticate(c);
    const squad = await deps.football.getSquad(c.req.param("id"));
    if (!squad) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json({ squad });
  });

  app.get("/matches/:id", async (c) => {
    await authenticate(c);
    const match = await deps.football.getMatch(c.req.param("id"));
    if (!match) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    let mode;
    try {
      mode = resolveRequestMode({
        appMode: deps.config.server.sportsData.appMode,
        clientMode: c.req.query("mode") ?? c.req.header("x-kickr-mode"),
      });
    } catch (error) {
      throw new AppError("VALIDATION", 400, error instanceof Error ? error.message : "Invalid mode");
    }
    if (!matchBelongsToMode(match.dataSource.provider, mode)) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    const appMode = deps.config.server.sportsData.appMode;
    if (mode === "DEMO" && (appMode === "DEMO" || appMode === "DUAL")) {
      const allowed = new Set(buildDemoSingleMatchCatalog().matches.map((m) => m.id));
      if (!allowed.has(match.id)) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
    }
    if (mode === "LIVE" && (appMode === "LIVE" || appMode === "DUAL")) {
      const liveId = deps.config.server.sportsData.liveFixtureId;
      if (match.externalFixtureId !== liveId) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
    }
    return c.json({ match, mode: mode ?? null });
  });

  app.get("/matches/:id/my-team", async (c) => {
    const principal = await authenticate(c);
    const owned = await deps.football.getMyTeamForMatch(principal.accountId, c.req.param("id"));
    if (!owned) {
      return c.json({ team: null, latest: null, readOnly: false });
    }
    return c.json({
      team: owned.team,
      latest: owned.latest,
      readOnly: owned.readOnly,
    });
  });

  app.post("/teams", async (c) => {
    const principal = await authenticate(c);
    const body = createTeamSchema.parse(await readBody(c));
    const team = await deps.football.createTeam(principal.accountId, body.matchId, {
      now: deps.clock(),
      correlationId: c.get("requestId") ?? null,
    });
    return c.json({ team }, 201);
  });

  app.get("/teams/:id/versions", async (c) => {
    const principal = await authenticate(c);
    const versions = await deps.football.listVersions(c.req.param("id"), principal.accountId);
    if (!versions) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json({ versions });
  });

  app.post("/teams/:id/versions", async (c) => {
    const principal = await authenticate(c);
    const body = saveVersionSchema.parse(await readBody(c));
    const version = await deps.football.saveVersion(
      c.req.param("id"),
      principal.accountId,
      body,
      { now: deps.clock(), correlationId: c.get("requestId") ?? null },
    );
    return c.json({ version }, 201);
  });

  app.get("/teams/:id", async (c) => {
    const principal = await authenticate(c);
    const owned = await deps.football.getTeamForAccount(c.req.param("id"), principal.accountId);
    if (!owned) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json(owned);
  });
}

async function readBody(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > 16_384) {
    throw new AppError("VALIDATION", 400, "Body too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION", 400, "Body must be JSON");
  }
}
