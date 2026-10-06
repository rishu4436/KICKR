import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/types.js";
import { buildShareCard } from "../profile/share.js";
import { AppError } from "../shared/errors.js";
import { rejectLeagueMoneyPath } from "../leagues/money-guard.js";
import type { AppDeps, AppEnv } from "./server.js";
import { consumeLimit, replayOrRun } from "./guard.js";

const uuidSchema = z.string().uuid();

const createSchema = z
  .object({
    name: z.string().min(3).max(48),
    matchId: uuidSchema,
    capacity: z.number().int().min(2).max(50),
  })
  .strict();

const joinSchema = z
  .object({
    inviteCode: z.string().min(6).max(16),
    teamVersionId: uuidSchema,
  })
  .strict();

export function registerLeagueRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.post("/leagues", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const body = createSchema.parse(await readBody(c));
    await consumeLimit(deps, c, "reservation", `${principal.accountId}:league-create`);
    const result = await replayOrRun(
      deps,
      c,
      "league-create",
      { accountId: principal.accountId, matchId: body.matchId, name: body.name, capacity: body.capacity },
      async () => {
        const league = await deps.leagues!.create(
          {
            name: body.name,
            matchId: body.matchId,
            capacity: body.capacity,
            accountId: principal.accountId,
            wallet: principal.walletAddress,
          },
          context(deps, c),
        );
        return { status: 201 as const, body: { league } };
      },
    );
    return c.json(result.body, result.status as 201);
  });

  app.get("/leagues/mine", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const leagues = await deps.leagues.listMine(principal.walletAddress, principal.accountId);
    return c.json({ leagues });
  });

  app.get("/leagues/invite/:code", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const league = await deps.leagues.previewInvite(c.req.param("code"), principal.walletAddress);
    return c.json({ league });
  });

  app.post("/leagues/join", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const body = joinSchema.parse(await readBody(c));
    await consumeLimit(deps, c, "reservation", `${principal.accountId}:league-join`);
    const result = await replayOrRun(
      deps,
      c,
      "league-join",
      {
        accountId: principal.accountId,
        inviteCode: body.inviteCode,
        teamVersionId: body.teamVersionId,
      },
      async () => {
        const joined = await deps.leagues!.join(
          {
            inviteCode: body.inviteCode,
            accountId: principal.accountId,
            wallet: principal.walletAddress,
            teamVersionId: body.teamVersionId,
          },
          context(deps, c),
        );
        return { status: 201 as const, body: joined };
      },
    );
    return c.json(result.body, result.status as 201);
  });

  app.get("/leagues/:id", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const league = await deps.leagues.get(c.req.param("id"), principal.walletAddress);
    return c.json({ league });
  });

  app.get("/leagues/:id/leaderboard", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const board = await deps.leagues.leaderboard(
      c.req.param("id"),
      principal.walletAddress,
      context(deps, c),
    );
    return c.json(board);
  });

  app.get("/leagues/:id/result", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    await authenticate(c);
    const result = await deps.leagues.getResult(c.req.param("id"));
    if (!result) return c.json({ status: null, result: null });
    return c.json({ status: result.status, result });
  });

  app.get("/leagues/:id/share", async (c) => {
    if (!deps.leagues) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const leagueId = c.req.param("id");
    const league = await deps.leagues.get(leagueId, principal.walletAddress);
    const result = await deps.leagues.getResult(leagueId);
    let myRow = result?.rows.find((r) => r.wallet === principal.walletAddress) ?? null;
    if (!myRow) {
      const board = await deps.leagues.leaderboard(leagueId, principal.walletAddress, context(deps, c));
      const liveRow = board.rows.find((r) => r.you) ?? null;
      if (liveRow) {
        myRow = {
          memberId: "",
          wallet: liveRow.wallet,
          teamVersionId: liveRow.teamVersionId,
          finalScoreMilliPoints: liveRow.milliPoints,
          rank: liveRow.rank,
        };
      }
    }
    if (!league.youJoined && !league.isOwner) {
      throw new AppError("FORBIDDEN", 403, "Join the league to share your result");
    }
    const match = await deps.football.getMatch(league.matchId);
    const matchLabel = match
      ? `${match.home.name} vs ${match.away.name}`
      : league.matchId;
    let captain: string | null = null;
    if (myRow?.teamVersionId) {
      try {
        const version = await deps.football.getVersionForAccount(myRow.teamVersionId, principal.accountId);
        if (version) {
          const pool = await deps.football.getPlayerPool(league.matchId);
          const cap = pool?.find((p) => p.playerId === version.version.captainId);
          captain = cap?.displayName ?? null;
        }
      } catch {
        captain = null;
      }
    }
    const card = buildShareCard({
      kind: "PRIVATE_LEAGUE",
      label: league.name,
      matchLabel,
      rank: myRow?.rank ?? null,
      scoreMilliPoints: myRow?.finalScoreMilliPoints ?? null,
      captain,
      path: `#/share/league/${league.id}`,
      sharePath: `/share/league/${league.id}`,
    });
    return c.json({ share: card });
  });

  // Explicit money-path isolation: league ids must never work on contest money routes,
  // and these aliases fail closed if called.
  for (const path of ["deposit", "claim", "settlement", "reservation"] as const) {
    app.post(`/leagues/:id/${path}`, async (c) => {
      await authenticate(c);
      rejectLeagueMoneyPath(path, c.req.param("id"));
    });
  }
}

function context(deps: AppDeps, c: Context<AppEnv>) {
  return {
    now: deps.clock(),
    correlationId: c.get("requestId") ?? null,
  };
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
