import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/types.js";
import { buildShareCard } from "../profile/share.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";
import { consumeLimit, replayOrRun } from "./guard.js";

const displayNameSchema = z
  .object({
    displayName: z.string().min(1).max(32),
  })
  .strict();

export function registerProfileRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.get("/v1/profile/:wallet", async (c) => {
    if (!deps.profiles) throw new AppError("NOT_FOUND", 404, "Not found");
    await authenticate(c);
    const profile = await deps.profiles.getByWallet(c.req.param("wallet"));
    return c.json({ profile });
  });

  app.get("/v1/me/profile", async (c) => {
    if (!deps.profiles) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const profile = await deps.profiles.getByWallet(principal.walletAddress);
    return c.json({ profile });
  });

  app.patch("/v1/me/profile", async (c) => {
    if (!deps.profiles) throw new AppError("NOT_FOUND", 404, "Not found");
    const principal = await authenticate(c);
    const body = displayNameSchema.parse(await readBody(c));
    await consumeLimit(deps, c, "auth-login", `${principal.accountId}:profile`);
    const result = await replayOrRun(
      deps,
      c,
      "profile-update",
      { accountId: principal.accountId, displayName: body.displayName },
      async () => {
        const profile = await deps.profiles!.updateDisplayName(
          principal.accountId,
          principal.walletAddress,
          body.displayName,
          { now: deps.clock(), correlationId: c.get("requestId") ?? null },
        );
        return { status: 200 as const, body: { profile } };
      },
    );
    return c.json(result.body, result.status as 200);
  });

  app.get("/contests/:id/share", async (c) => {
    const principal = await authenticate(c);
    const contestId = c.req.param("id");
    const contest = await deps.contests.getContest(contestId);
    const free = await deps.contests.getFreeResult(contestId);
    const myRow = free?.rows.find((r) => r.wallet === principal.walletAddress) ?? null;
    const match = await deps.football.getMatch(contest.matchId);
    const matchLabel = match ? `${match.home.name} vs ${match.away.name}` : contest.matchId;
    let captain: string | null = null;
    if (myRow) {
      try {
        const version = await deps.football.getVersionForAccount(myRow.teamVersionId, principal.accountId);
        if (version) {
          const pool = await deps.football.getPlayerPool(contest.matchId);
          const cap = pool?.find((p) => p.playerId === version.version.captainId);
          captain = cap?.displayName ?? null;
        }
      } catch {
        captain = null;
      }
    }
    const card = buildShareCard({
      kind: "FREE_CONTEST",
      label: contest.contestKind === "FREE" ? `FREE ${contest.templateCode}` : contest.templateCode,
      matchLabel,
      rank: myRow?.rank ?? null,
      scoreMilliPoints: myRow?.finalScoreMilliPoints ?? null,
      captain,
      path: `#/share/contest/${contestId}`,
      sharePath: `/share/contest/${contestId}`,
    });
    return c.json({ share: card });
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
