import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/types.js";
import type { Permission } from "../rbac/permissions.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";
import { consumeLimit, replayOrRun } from "./guard.js";

const uuidSchema = z.string().uuid();

const reserveSchema = z.object({
  teamVersionId: uuidSchema,
  wallet: z.string().min(32).max(44).optional(),
}).strict();

const submissionSchema = z.object({
  signature: z.string().min(64).max(100),
}).strict();

export function registerContestRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
  authorize: (c: Context<AppEnv>, permission: Permission) => Promise<void>,
): void {
  app.get("/matches/:id/contests", async (c) => {
    const principal = await authenticate(c);
    const contests = await deps.contests.listMatchContests(
      c.req.param("id"),
      principal.walletAddress,
      context(deps, c),
    );
    return c.json({ contests });
  });

  app.get("/contests/:id", async (c) => {
    await authenticate(c);
    const contest = await deps.contests.getContest(c.req.param("id"));
    return c.json({ contest });
  });

  app.post("/contests/:id/reservations", async (c) => {
    const principal = await authenticate(c);
    const contestId = c.req.param("id");
    if (!uuidSchema.safeParse(contestId).success) {
      throw new AppError("VALIDATION", 400, "Contest id must be a uuid");
    }
    const body = reserveSchema.parse(await readBody(c));
    if (body.wallet && body.wallet !== principal.walletAddress) {
      throw new AppError("WALLET_MISMATCH", 400, "Wallet does not match the signed-in account");
    }
    await consumeLimit(deps, c, "reservation", `${principal.accountId}:${contestId}`);
    const result = await replayOrRun(
      deps,
      c,
      "reservation",
      { contestId, accountId: principal.accountId, teamVersionId: body.teamVersionId },
      async () => {
        const reserved = await deps.contests.reserve(
          contestId,
          principal.accountId,
          principal.walletAddress,
          body.teamVersionId,
          context(deps, c),
        );
        return { status: 201, body: reserved };
      },
    );
    return c.json(result.body, result.status as 201);
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

  app.post("/reservations/:id/deposit-submission", async (c) => {
    const principal = await authenticate(c);
    const reservationId = c.req.param("id");
    if (!uuidSchema.safeParse(reservationId).success) {
      throw new AppError("VALIDATION", 400, "Reservation id must be a uuid");
    }
    const body = submissionSchema.parse(await readBody(c));
    await consumeLimit(deps, c, "deposit", `${principal.accountId}:${reservationId}`);
    const result = await replayOrRun(
      deps,
      c,
      "deposit",
      { reservationId, signature: body.signature },
      async () => {
        const submitted = await deps.contests.submitDepositSignature(
          reservationId,
          principal.walletAddress,
          body.signature,
          context(deps, c),
        );
        return { status: 202, body: submitted };
      },
    );
    return c.json(result.body, result.status as 202);
  });

  app.get("/contests/:id/deposits", async (c) => {
    await authenticate(c);
    await authorize(c, "READ_CONTEST");
    const deposits = await deps.contests.listDeposits(c.req.param("id"));
    return c.json({
      deposits: deposits.map((entry) => ({
        entryId: entry.id,
        contestId: entry.contestId,
        wallet: entry.wallet,
        teamVersionId: entry.teamVersionId,
        status: entry.status,
        confirmationStatus: entry.confirmationStatus,
        depositSignature: entry.depositSignature,
        confirmedSlot: entry.confirmedSlot,
        amountBaseUnits: entry.chainAmountBaseUnits,
        mint: entry.mint,
        vault: entry.vaultAddress,
        depositReceipt: entry.depositReceipt,
      })),
    });
  });

  app.get("/deposits/health", async (c) => {
    await authenticate(c);
    await authorize(c, "READ_SYSTEM");
    const health = await deps.contests.depositHealth();
    return c.json({
      ...health,
      rpcErrors: null,
      indexerLagMs: null,
      note: "RPC errors and indexer lag are counted by the indexer process. This response has no credentials and cannot confirm a deposit.",
    });
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
