/**
 * Private Match Ops HTTP API (Phase 18D.2).
 * Route family: /v1/ops/match-ops/*
 * UI: /ops/matches — never linked from consumer navigation.
 */
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/types.js";
import { grantedPermissions } from "../rbac/authorize.js";
import { ROLE_PERMISSIONS, type RoleCode } from "../rbac/matrix.js";
import type { Permission } from "../rbac/permissions.js";
import {
  createMatchOperationsService,
  type MatchOpsActor,
  type MatchOperationsService,
} from "../ops/match-operations.js";
import { OPERATOR_EVENT_TYPES } from "../sports/operator-provider.js";
import { isPlayerRole } from "../domain/football/roles.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";

const MATCH_STATES = [
  "SCHEDULED",
  "LINEUPS_AVAILABLE",
  "LOCKED",
  "LIVE",
  "HALFTIME",
  "FULL_TIME",
  "DATA_FINALIZING",
  "FINAL",
  "POSTPONED",
  "CANCELLED",
  "ABANDONED",
  "VOID",
] as const;

const createFixtureSchema = z.object({
  competition: z.string().min(2).max(120),
  venue: z.string().max(120).nullable().optional(),
  kickoffAt: z.string().datetime(),
  homeClub: z.object({ name: z.string().min(2).max(80), shortName: z.string().min(1).max(8) }),
  awayClub: z.object({ name: z.string().min(2).max(80), shortName: z.string().min(1).max(8) }),
  players: z
    .array(
      z.object({
        displayName: z.string().min(1).max(80),
        shortName: z.string().min(1).max(16),
        position: z.string(),
        clubSide: z.enum(["home", "away"]),
        creditValue: z.number().int().min(1).max(20),
        jersey: z.number().int().min(1).max(99).nullable().optional(),
        startingStatus: z.enum(["STARTER", "BENCH", "UNKNOWN"]).optional(),
        availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]).optional(),
      }),
    )
    .min(2)
    .max(40),
});

const proposeSchema = z.object({
  matchId: z.string().uuid(),
  eventType: z.enum(OPERATOR_EVENT_TYPES as unknown as [string, ...string[]]),
  primaryPlayerId: z.string().uuid(),
  secondaryPlayerId: z.string().uuid().nullable().optional(),
  matchMinute: z.number().int().min(0).max(130).nullable().optional(),
  note: z.string().max(500).nullable().optional(),
  source: z.enum(["MANUAL_OPERATOR", "GROK_PROPOSED"]),
  providerEventId: z.string().min(3).max(200).optional(),
});

const services = new WeakMap<object, MatchOperationsService>();

export function getMatchOpsService(deps: AppDeps): MatchOperationsService {
  if (!deps.footballStore) {
    throw new AppError("NOT_FOUND", 503, "Football store unavailable for Match Ops");
  }
  const key = deps.footballStore as object;
  let service = services.get(key);
  if (!service) {
    service = createMatchOperationsService({
      footballStore: deps.footballStore,
      live: deps.live,
      audit: deps.audit,
      clock: deps.clock,
    });
    services.set(key, service);
  }
  return service;
}

/** Test seam. */
export function resetMatchOpsServiceForTests(): void {
  /* WeakMap entries drop with store GC; no global to clear. */
}

function primaryRole(roles: readonly string[]): string {
  const order: RoleCode[] = ["CEO_HEAD", "BACKEND_DEVELOPER", "PRODUCT_MANAGER", "APP_DEVELOPER", "TESTER", "SUPPORT", "UI_UX_DEVELOPER"];
  for (const role of order) {
    if (roles.includes(role)) return role;
  }
  return roles[0] ?? "UNKNOWN";
}

async function requireMatchOps(
  deps: AppDeps,
  c: Context<AppEnv>,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): Promise<{ principal: Principal; actor: MatchOpsActor; permissions: ReadonlySet<Permission> }> {
  const principal = await authenticate(c);
  const [roles, capabilities] = await Promise.all([
    deps.grants.listRoles(principal.accountId),
    deps.grants.listCapabilities(principal.accountId),
  ]);
  const permissions = grantedPermissions({ roles, capabilities });
  if (!permissions.has("MANAGE_MATCH_OPERATIONS")) {
    await deps.audit.append({
      action: "MATCH_OPS_DENIED",
      occurredAt: deps.clock(),
      entityType: "PERMISSION",
      entityId: "MANAGE_MATCH_OPERATIONS",
      metadata: {
        path: c.req.path,
        roles,
        requestId: c.get("requestId") ?? null,
      },
      actorAccountId: principal.accountId,
      actorWallet: principal.walletAddress,
      correlationId: c.get("requestId") ?? null,
    });
    throw new AppError("FORBIDDEN", 403, "MANAGE_MATCH_OPERATIONS required");
  }
  // Defense in depth: Support / UI / Product must not gain write via mis-grant.
  const blocked = roles.filter((r) => r === "SUPPORT" || r === "UI_UX_DEVELOPER" || r === "PRODUCT_MANAGER");
  if (blocked.length && !roles.includes("CEO_HEAD") && !roles.includes("BACKEND_DEVELOPER")) {
    throw new AppError("FORBIDDEN", 403, "Support/UI/Product cannot write Match Ops");
  }
  void ROLE_PERMISSIONS;
  const actor: MatchOpsActor = {
    accountId: principal.accountId,
    walletAddress: principal.walletAddress,
    role: primaryRole(roles),
    requestId: c.get("requestId") ?? null,
  };
  return { principal, actor, permissions };
}

export function registerMatchOpsRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  app.get("/v1/ops/match-ops/session", async (c) => {
    const { principal, permissions, actor } = await requireMatchOps(deps, c, authenticate);
    return c.json({
      accountId: principal.accountId,
      walletAddress: principal.walletAddress,
      role: actor.role,
      permission: "MANAGE_MATCH_OPERATIONS",
      capabilities: [...permissions].sort(),
      surface: "match-ops",
      consumerNav: false,
    });
  });

  app.get("/v1/ops/match-ops/matches", async (c) => {
    await requireMatchOps(deps, c, authenticate);
    const service = getMatchOpsService(deps);
    const matches = await service.listOperatorMatches();
    const clubMap = new Map(
      await Promise.all(
        matches.map(async (m) => {
          const home = await deps.footballStore!.getClub(m.homeClubId);
          const away = await deps.footballStore!.getClub(m.awayClubId);
          return [m.id, { home, away }] as const;
        }),
      ),
    );
    return c.json({
      matches: matches.map((m) => ({
        id: m.id,
        competition: m.competition,
        venue: m.venue,
        kickoffAt: m.kickoffAt,
        status: m.status,
        provenance: m.dataSource.provenance ?? "OPERATOR_MANAGED",
        provider: m.dataSource.provider,
        label: m.dataSource.label,
        home: clubMap.get(m.id)?.home ?? null,
        away: clubMap.get(m.id)?.away ?? null,
      })),
    });
  });

  app.get("/v1/ops/match-ops/matches/:id", async (c) => {
    await requireMatchOps(deps, c, authenticate);
    const service = getMatchOpsService(deps);
    return c.json(await service.getMatchBundle(c.req.param("id")));
  });

  app.post("/v1/ops/match-ops/matches", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const body = createFixtureSchema.parse(await c.req.json());
    for (const player of body.players) {
      if (!isPlayerRole(player.position)) {
        throw new AppError("VALIDATION", 400, `invalid position ${player.position}`);
      }
    }
    const service = getMatchOpsService(deps);
    const created = await service.createFixture(actor, {
      ...body,
      players: body.players.map((p) => ({
        ...p,
        position: p.position as "GK" | "DEF" | "MID" | "FWD",
      })),
    });
    return c.json(created, 201);
  });

  app.patch("/v1/ops/match-ops/matches/:id", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const body = z
      .object({
        competition: z.string().min(2).max(120).optional(),
        venue: z.string().max(120).nullable().optional(),
        kickoffAt: z.string().datetime().optional(),
        status: z.enum(MATCH_STATES).optional(),
        reason: z.string().max(500).optional(),
      })
      .parse(await c.req.json());
    const service = getMatchOpsService(deps);
    const match = await service.updateFixture(actor, c.req.param("id"), body);
    return c.json({ match });
  });

  app.patch("/v1/ops/match-ops/matches/:id/squad/:playerId", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const body = z
      .object({
        fantasyPosition: z.string().optional(),
        creditValue: z.number().int().min(1).max(20).optional(),
        startingStatus: z.enum(["STARTER", "BENCH", "UNKNOWN"]).optional(),
        availability: z.enum(["AVAILABLE", "UNAVAILABLE", "UNKNOWN"]).optional(),
        squadStatus: z.enum(["INCLUDED", "EXCLUDED"]).optional(),
        reason: z.string().max(500).optional(),
      })
      .parse(await c.req.json());
    if (body.fantasyPosition && !isPlayerRole(body.fantasyPosition)) {
      throw new AppError("VALIDATION", 400, "invalid fantasyPosition");
    }
    const service = getMatchOpsService(deps);
    const squad = await service.updateSquadPlayer(actor, c.req.param("id"), c.req.param("playerId"), {
      ...body,
      fantasyPosition: body.fantasyPosition as "GK" | "DEF" | "MID" | "FWD" | undefined,
    });
    return c.json({ squad });
  });

  app.post("/v1/ops/match-ops/matches/:id/credits", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const body = z
      .object({
        playerId: z.string().uuid(),
        creditValue: z.number().int().min(1).max(20),
        reason: z.string().min(3).max(500),
      })
      .parse(await c.req.json());
    const service = getMatchOpsService(deps);
    const result = await service.editCredit(
      actor,
      c.req.param("id"),
      body.playerId,
      body.creditValue,
      body.reason,
    );
    return c.json(result);
  });

  app.get("/v1/ops/match-ops/matches/:id/proposals", async (c) => {
    await requireMatchOps(deps, c, authenticate);
    const service = getMatchOpsService(deps);
    return c.json({ proposals: service.listProposals(c.req.param("id")) });
  });

  app.post("/v1/ops/match-ops/proposals", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const body = proposeSchema.parse(await c.req.json());
    const service = getMatchOpsService(deps);
    const proposal = await service.proposeEvent(actor, body);
    return c.json({ proposal }, 201);
  });

  app.post("/v1/ops/match-ops/proposals/:id/review", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const service = getMatchOpsService(deps);
    const proposal = await service.reviewProposal(actor, c.req.param("id"));
    return c.json({ proposal });
  });

  app.post("/v1/ops/match-ops/proposals/:id/confirm", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const service = getMatchOpsService(deps);
    const ctx = { now: deps.clock(), correlationId: c.get("requestId") ?? null };
    const result = await service.confirmProposal(actor, c.req.param("id"), ctx);
    return c.json({
      proposal: result.proposal,
      event: result.event,
      leaderboard: result.rebuilt.leaderboard,
      playerScores: result.rebuilt.playerScores,
    });
  });

  app.post("/v1/ops/match-ops/matches/:id/corrections", async (c) => {
    const { actor } = await requireMatchOps(deps, c, authenticate);
    const body = z
      .object({
        originalEventId: z.string().uuid(),
        note: z.string().max(500).nullable().optional(),
        providerEventId: z.string().min(3).max(200).optional(),
      })
      .parse(await c.req.json());
    const service = getMatchOpsService(deps);
    const ctx = { now: deps.clock(), correlationId: c.get("requestId") ?? null };
    const result = await service.appendCorrection(
      actor,
      { matchId: c.req.param("id"), ...body },
      ctx,
    );
    return c.json({
      correction: result.correction,
      leaderboard: result.rebuilt.leaderboard,
      playerScores: result.rebuilt.playerScores,
    });
  });

  app.get("/v1/ops/match-ops/matches/:id/audit", async (c) => {
    await requireMatchOps(deps, c, authenticate);
    const service = getMatchOpsService(deps);
    return c.json({ mutations: service.listMutations(c.req.param("id")) });
  });

  app.get("/v1/ops/match-ops/audit", async (c) => {
    await requireMatchOps(deps, c, authenticate);
    const service = getMatchOpsService(deps);
    return c.json({ mutations: service.listMutations() });
  });
}
