import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/types.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";

const uuidSchema = z.string().uuid();

const reserveSchema = z.object({
  teamVersionId: uuidSchema,
  wallet: z.string().min(32).max(44).optional(),
}).strict();

export function registerContestRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.get("/matches/:id/contests", async (c) => {
    await authenticate(c);
    const contests = await deps.contests.listDiscoverable(c.req.param("id"), context(deps, c));
    return c.json({ contests });
  });

  app.get("/contests/:id", async (c) => {
    await authenticate(c);
    const contest = await deps.contests.getContest(c.req.param("id"));
    return c.json({ contest });
  });

  app.post("/contests/:id/reservations", async (c) => {
    const principal = await authenticate(c);
    const body = reserveSchema.parse(await readBody(c));
    if (body.wallet && body.wallet !== principal.walletAddress) {
      throw new AppError("WALLET_MISMATCH", 400, "Wallet does not match the signed-in account");
    }
    const reserved = await deps.contests.reserve(
      c.req.param("id"),
      principal.accountId,
      principal.walletAddress,
      body.teamVersionId,
      context(deps, c),
    );
    return c.json(reserved, 201);
  });

  app.get("/reservations/:id", async (c) => {
    const principal = await authenticate(c);
    const reservation = await deps.contests.getReservation(
      c.req.param("id"),
      principal.walletAddress,
      context(deps, c),
    );
    return c.json(reservation);
  });
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
