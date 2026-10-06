import type { Context, Hono } from "hono";
import { z } from "zod";
import type { Principal } from "../auth/types.js";
import { grantedPermissions } from "../rbac/authorize.js";
import { CAPABILITIES, ROLES, type CapabilityCode } from "../rbac/matrix.js";
import { AUDIT_EVENTS } from "../audit/events.js";
import { hasOpsCapability, opsCapabilitiesFor, type OpsCapabilityClass } from "../rbac/ops-capabilities.js";
import type { Permission } from "../rbac/permissions.js";
import {
  grantOpsCapability,
  grantOpsRole,
  listOpsMembers,
  removeOpsCapability,
  removeOpsRole,
  revokeOpsSession,
  suspendOpsAccount,
  type OpsActor,
} from "../ops/access.js";
import {
  buildContestDetail,
  buildDiagnostics,
  buildEntryDetail,
  buildMatchDetail,
  buildOverview,
  buildProviderConfig,
  buildSettlementDetail,
  listOpsClaims,
  listOpsContests,
  listOpsEntries,
  listOpsMatches,
  listOpsSettlements,
  queryOpsAudit,
  type OpsReadDeps,
} from "../ops/read-model.js";
import { assertApproverIsNotCalculator } from "../settlement/approval-guard.js";
import { AppError } from "../shared/errors.js";
import type { AppDeps, AppEnv } from "./server.js";
import { consumeLimit, replayOrRun } from "./guard.js";

const uuidSchema = z.string().uuid();

export function registerOpsRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): void {
  const funds: Array<[string, string]> = [
    ["/v1/ops/treasury/withdraw", ""],
    ["/v1/ops/vault/transfer", ""],
    ["/v1/ops/vault/sweep", ""],
    ["/v1/ops/payouts", ""],
  ];
  for (const [path] of funds) {
    app.post(path, (c) => denyFunds(deps, c, authenticate));
  }
  app.post("/v1/ops/claims/:id/mark-paid", (c) => denyFunds(deps, c, authenticate));
  app.post("/v1/ops/settlements/:id/prepare", (c) => denyFunds(deps, c, authenticate));
  app.post("/v1/ops/settlements/:id/execute", (c) => denyFunds(deps, c, authenticate));
  app.post("/v1/ops/settlements/:id/run", (c) => denyFunds(deps, c, authenticate));
  app.post("/v1/ops/settlements/:id/settle", (c) => denyFunds(deps, c, authenticate));
  app.post("/v1/ops/attestations/:id/mark-valid", (c) => denyFunds(deps, c, authenticate));
  app.post("/v1/ops/attestations/:id/override", (c) => denyFunds(deps, c, authenticate));
  app.post("/v1/ops/settlements/:id/attestation/approve", (c) => denyFunds(deps, c, authenticate));

  app.get("/v1/ops/session", async (c) => {
    const { principal, permissions } = await begin(deps, c, authenticate);
    const capabilities = opsCapabilitiesFor(permissions);
    if (capabilities.length === 0) {
      await deny(deps, c, principal, null);
    }
    return c.json({
      accountId: principal.accountId,
      walletAddress: principal.walletAddress,
      sessionId: principal.sessionId,
      authMode: "solana_wallet",
      capabilities,
      runSettlement: "not_granted",
    });
  });

  app.get("/v1/ops/overview", async (c) => {
    const { gate } = await requireCapability(deps, c, authenticate, "READ_PLATFORM");
    return c.json(await buildOverview(reads(deps), gate, deps.clock()));
  });

  app.get("/v1/ops/matches/:id", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_MATCHES");
    return c.json(await buildMatchDetail(reads(deps), c.req.param("id")));
  });

  app.get("/v1/ops/matches", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_MATCHES");
    return c.json(await listOpsMatches(reads(deps)));
  });

  app.get("/v1/ops/contests/:id", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_CONTESTS");
    return c.json(await buildContestDetail(reads(deps), c.req.param("id")));
  });

  app.get("/v1/ops/contests", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_CONTESTS");
    return c.json(await listOpsContests(reads(deps)));
  });

  app.get("/v1/ops/entries/:id", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_ENTRIES");
    const contestId = c.req.query("contestId");
    if (!contestId || !uuidSchema.safeParse(contestId).success) {
      throw new AppError("VALIDATION", 400, "contestId is required");
    }
    return c.json(await buildEntryDetail(reads(deps), c.req.param("id"), contestId));
  });

  app.get("/v1/ops/entries", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_ENTRIES");
    const contestId = c.req.query("contestId");
    if (contestId && !uuidSchema.safeParse(contestId).success) {
      throw new AppError("VALIDATION", 400, "contestId must be a uuid");
    }
    return c.json(await listOpsEntries(reads(deps), contestId));
  });

  app.get("/v1/ops/settlements/:id", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_SETTLEMENTS");
    return c.json(await buildSettlementDetail(reads(deps), c.req.param("id")));
  });

  app.get("/v1/ops/settlements", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_SETTLEMENTS");
    return c.json(await listOpsSettlements(reads(deps)));
  });

  app.get("/v1/ops/claims/:id/proof", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "READ_CLAIMS");
    await deps.audit.append({
      action: "PERMISSION_DENIED",
      occurredAt: deps.clock(),
      entityType: "CLAIM",
      entityId: c.req.param("id"),
      metadata: { result: "denied", reason: "owner_scoped", capability: "READ_CLAIMS" },
      actorAccountId: principal.accountId,
      actorWallet: principal.walletAddress,
      correlationId: c.get("requestId") ?? null,
    });
    throw new AppError("FORBIDDEN", 403, "Claim proof is owner-scoped and is not available to staff");
  });

  app.get("/v1/ops/claims", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_CLAIMS");
    return c.json(await listOpsClaims(reads(deps)));
  });

  app.get("/v1/ops/diagnostics", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_DIAGNOSTICS");
    return c.json(await buildDiagnostics(reads(deps), deps.clock()));
  });

  app.get("/v1/ops/provider-config", async (c) => {
    await requireCapability(deps, c, authenticate, "MANAGE_PROVIDER_CONFIG");
    return c.json(await buildProviderConfig(reads(deps)));
  });

  app.get("/v1/ops/audit/events", async (c) => {
    await requireCapability(deps, c, authenticate, "READ_AUDIT");
    return c.json(await queryOpsAudit(deps.audit, auditFilter(c)));
  });

  app.on(["PATCH", "PUT", "DELETE"], "/v1/ops/audit/events", () => rejectAuditMutation());
  app.on(["PATCH", "PUT", "DELETE"], "/v1/ops/audit/events/:id", () => rejectAuditMutation());

  app.get("/v1/ops/access/catalog", async (c) => {
    await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    return c.json({
      assignableRoles: ROLES,
      assignableCapabilities: CAPABILITIES,
      notAssignable: ["RUN_SETTLEMENT"],
      note: "RUN_SETTLEMENT is not granted to any role or capability.",
    });
  });

  app.get("/v1/ops/access/members/:id", async (c) => {
    await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    const members = await listOpsMembers(accessDeps(deps), deps.clock());
    const member = members.find((row) => row.accountId === c.req.param("id"));
    if (!member) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json({ member });
  });

  app.get("/v1/ops/access/members", async (c) => {
    await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    return c.json({ members: await listOpsMembers(accessDeps(deps), deps.clock()) });
  });

  app.post("/v1/ops/access/roles", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    const body = await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("GRANT_ROLE"),
      accountId: uuidSchema,
      role: z.enum(ROLES),
    }).strict());
    const result = await replayOrRun(deps, c, "ops-role-grant", body, async () => {
      const changed = await grantOpsRole(accessDeps(deps), actorOf(deps, c, principal), body.accountId, body.role);
      return { status: 201, body: changed };
    });
    return c.json(result.body, result.status as 201);
  });

  app.post("/v1/ops/access/roles/remove", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    const body = await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("REMOVE_ROLE"),
      accountId: uuidSchema,
      role: z.enum(ROLES),
    }).strict());
    const result = await replayOrRun(deps, c, "ops-role-remove", body, async () => ({
      status: 200,
      body: await removeOpsRole(accessDeps(deps), actorOf(deps, c, principal), body.accountId, body.role),
    }));
    return c.json(result.body, result.status as 200);
  });

  app.post("/v1/ops/access/capabilities", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    const body = await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("GRANT_CAPABILITY"),
      accountId: uuidSchema,
      capability: z.enum(CAPABILITIES),
    }).strict());
    const result = await replayOrRun(deps, c, "ops-capability-grant", body, async () => ({
      status: 201,
      body: await grantOpsCapability(
        accessDeps(deps),
        actorOf(deps, c, principal),
        body.accountId,
        body.capability as CapabilityCode,
      ),
    }));
    return c.json(result.body, result.status as 201);
  });

  app.post("/v1/ops/access/capabilities/remove", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    const body = await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("REMOVE_CAPABILITY"),
      accountId: uuidSchema,
      capability: z.enum(CAPABILITIES),
    }).strict());
    const result = await replayOrRun(deps, c, "ops-capability-remove", body, async () => ({
      status: 200,
      body: await removeOpsCapability(
        accessDeps(deps),
        actorOf(deps, c, principal),
        body.accountId,
        body.capability as CapabilityCode,
      ),
    }));
    return c.json(result.body, result.status as 200);
  });

  app.post("/v1/ops/access/suspend", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    const body = await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("SUSPEND_ACCOUNT"),
      accountId: uuidSchema,
    }).strict());
    const result = await replayOrRun(deps, c, "ops-suspend", body, async () => ({
      status: 200,
      body: await suspendOpsAccount(accessDeps(deps), actorOf(deps, c, principal), body.accountId),
    }));
    return c.json(result.body, result.status as 200);
  });

  app.post("/v1/ops/access/sessions/revoke", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "MANAGE_USERS");
    const body = await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("REVOKE_SESSION"),
      sessionId: uuidSchema,
    }).strict());
    const result = await replayOrRun(deps, c, "ops-session-revoke", body, async () => ({
      status: 200,
      body: await revokeOpsSession(accessDeps(deps), actorOf(deps, c, principal), body.sessionId),
    }));
    return c.json(result.body, result.status as 200);
  });

  app.post("/v1/ops/contests/:id/settlement/calculate", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "RUN_SCORING");
    await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("CALCULATE_RESULT"),
    }).strict());
    const contestId = c.req.param("id");
    const result = await replayOrRun(deps, c, "ops-settlement-calculate", { contestId, actorId: principal.accountId }, async () => {
      const orch = deps.settlementOrchestrator;
      if (!orch) {
        throw new AppError("NOT_FOUND", 404, "Settlement orchestrator is not available");
      }
      const settlement = await orch.calculateFromApprovedSnapshots({
        contestId,
        matchSettlementGate: "FINAL",
        actorId: principal.accountId,
        nowIso: deps.clock().toISOString(),
      });
      await deps.audit.append({
        action: "RESULT_CALCULATED",
        actorAccountId: principal.accountId,
        actorWallet: principal.walletAddress,
        entityType: "SETTLEMENT",
        entityId: settlement.id,
        metadata: { contestId: settlement.contestId, resultHash: settlement.resultHash, result: "calculated" },
        correlationId: c.get("requestId") ?? null,
        occurredAt: deps.clock(),
      });
      return {
        status: 200,
        body: {
          id: settlement.id,
          status: settlement.status,
          stage: "calculated",
          resultHash: settlement.resultHash,
          settlementVersion: settlement.settlementVersion,
        },
      };
    });
    return c.json(result.body, result.status as 200);
  });

  app.post("/v1/ops/settlements/:id/review", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "REVIEW_RESULT");
    await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("REVIEW_RESULT"),
    }).strict());
    const settlementId = c.req.param("id");
    const result = await replayOrRun(deps, c, "ops-settlement-review", { settlementId, actorId: principal.accountId }, async () => {
      const service = requireSettlement(deps);
      const settlement = await service.review(settlementId, principal.accountId, deps.clock().toISOString());
      await deps.audit.append({
        action: "RESULT_REVIEWED",
        actorAccountId: principal.accountId,
        actorWallet: principal.walletAddress,
        entityType: "SETTLEMENT",
        entityId: settlement.id,
        metadata: { contestId: settlement.contestId, resultHash: settlement.resultHash, result: "reviewed" },
        correlationId: c.get("requestId") ?? null,
        occurredAt: deps.clock(),
      });
      return { status: 200, body: { id: settlement.id, status: settlement.status, stage: "reviewed" } };
    });
    return c.json(result.body, result.status as 200);
  });

  app.post("/v1/ops/settlements/:id/reject", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "REVIEW_RESULT");
    const body = await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("REJECT_RESULT"),
      reason: z.string().min(1).max(240).optional(),
    }).strict());
    const service = requireSettlement(deps);
    const reason = body.reason?.trim() || "rejected";
    const settlement = await service.reject(c.req.param("id"), principal.accountId, reason, deps.clock().toISOString());
    await deps.audit.append({
      action: "RESULT_REJECTED",
      actorAccountId: principal.accountId,
      actorWallet: principal.walletAddress,
      entityType: "SETTLEMENT",
      entityId: settlement.id,
      metadata: { contestId: settlement.contestId, reason, result: "failure" },
      correlationId: c.get("requestId") ?? null,
      occurredAt: deps.clock(),
    });
    return c.json({ id: settlement.id, status: settlement.status, stage: "rejected" });
  });

  app.post("/v1/ops/settlements/:id/approve", async (c) => {
    const { principal } = await requireCapability(deps, c, authenticate, "REVIEW_RESULT");
    await confirmedBody(c, z.object({
      confirm: z.literal(true),
      confirmationText: z.literal("APPROVE_RESULT"),
    }).strict());
    const settlementId = c.req.param("id");
    const result = await replayOrRun(deps, c, "ops-settlement-approve", { settlementId, actorId: principal.accountId }, async () => {
      const service = requireSettlement(deps);
      await assertApproverIsNotCalculator(deps.audit, settlementId, principal.accountId);
      const settlement = await service.approve(settlementId, principal.accountId, deps.clock().toISOString());
      await deps.audit.append({
        action: "RESULT_APPROVED",
        actorAccountId: principal.accountId,
        actorWallet: principal.walletAddress,
        entityType: "SETTLEMENT",
        entityId: settlement.id,
        metadata: { contestId: settlement.contestId, resultHash: settlement.resultHash, result: "approved" },
        correlationId: c.get("requestId") ?? null,
        occurredAt: deps.clock(),
      });
      return { status: 200, body: { id: settlement.id, status: settlement.status, stage: "approved" } };
    });
    return c.json(result.body, result.status as 200);
  });
}

function reads(deps: AppDeps): OpsReadDeps {
  return {
    auth: deps.auth,
    audit: deps.audit,
    football: deps.football,
    contests: deps.contests,
    live: deps.live,
    settlement: deps.settlement,
    snapshots: deps.snapshots,
    attestationGate: deps.attestationGate,
    liveProviderConfigured: deps.config.public.liveProviderConfigured,
    providerName: deps.config.server.sportsData.liveProvider,
    cluster: deps.config.public.solanaCluster,
    counters: deps.counters?.snapshot() ?? null,
  };
}

function accessDeps(deps: AppDeps) {
  return { auth: deps.auth, grants: deps.grants, audit: deps.audit };
}

function actorOf(deps: AppDeps, c: Context<AppEnv>, principal: Principal): OpsActor {
  return {
    accountId: principal.accountId,
    walletAddress: principal.walletAddress,
    correlationId: c.get("requestId") ?? null,
    now: deps.clock(),
  };
}

async function begin(
  deps: AppDeps,
  c: Context<AppEnv>,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): Promise<{ principal: Principal; permissions: Set<Permission> }> {
  const principal = await authenticate(c);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    await consumeLimit(deps, c, "ops", `${principal.accountId}:${c.req.method}:${c.req.path}`);
  }
  const claimed = c.req.header("x-wallet-address");
  if (claimed !== undefined && claimed !== principal.walletAddress) {
    await deps.audit.append({
      action: "PERMISSION_DENIED",
      occurredAt: deps.clock(),
      entityType: "SESSION",
      entityId: principal.sessionId,
      metadata: { result: "denied", reason: "wallet_mismatch", path: c.req.path },
      actorAccountId: principal.accountId,
      actorWallet: principal.walletAddress,
      correlationId: c.get("requestId") ?? null,
    });
    throw new AppError("WALLET_MISMATCH", 400, "Wallet does not match the signed-in session");
  }
  const [roles, capabilities] = await Promise.all([
    deps.grants.listRoles(principal.accountId),
    deps.grants.listCapabilities(principal.accountId),
  ]);
  return { principal, permissions: grantedPermissions({ roles, capabilities }) };
}

async function requireCapability(
  deps: AppDeps,
  c: Context<AppEnv>,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
  capability: OpsCapabilityClass,
): Promise<{ principal: Principal; permissions: Set<Permission>; gate: Set<Permission> }> {
  const opened = await begin(deps, c, authenticate);
  if (!hasOpsCapability(opened.permissions, capability)) {
    await deny(deps, c, opened.principal, capability);
  }
  return { ...opened, gate: opened.permissions };
}

async function deny(
  deps: AppDeps,
  c: Context<AppEnv>,
  principal: Principal,
  capability: string | null,
): Promise<never> {
  await deps.audit.append({
    action: "PERMISSION_DENIED",
    occurredAt: deps.clock(),
    entityType: "ROUTE",
    entityId: c.req.path.slice(0, 128),
    metadata: { result: "denied", capability, method: c.req.method },
    actorAccountId: principal.accountId,
    actorWallet: principal.walletAddress,
    correlationId: c.get("requestId") ?? null,
  });
  throw new AppError("FORBIDDEN", 403, "Permission denied");
}

async function denyFunds(
  deps: AppDeps,
  c: Context<AppEnv>,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
): Promise<Response> {
  const { principal } = await begin(deps, c, authenticate);
  await deps.audit.append({
    action: "PERMISSION_DENIED",
    occurredAt: deps.clock(),
    entityType: "ROUTE",
    entityId: c.req.path.slice(0, 128),
    metadata: { result: "denied", capability: "RUN_SETTLEMENT", reason: "funds_movement" },
    actorAccountId: principal.accountId,
    actorWallet: principal.walletAddress,
    correlationId: c.get("requestId") ?? null,
  });
  throw new AppError(
    "FUNDS_MOVEMENT_DENIED",
    403,
    "The control center cannot move USDC or grant settlement authority",
  );
}

function rejectAuditMutation(): never {
  throw new AppError("AUDIT_APPEND_ONLY", 405, "Audit records cannot be modified or deleted");
}

async function confirmedBody<T>(c: Context<AppEnv>, schema: z.ZodType<T>): Promise<T> {
  const text = await c.req.text();
  if (text.length > 16_384) {
    throw new AppError("VALIDATION", 400, "Body too large");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION", 400, "Body must be JSON");
  }
  if (JSON.stringify(parsed).includes("RUN_SETTLEMENT")) {
    throw new AppError("SETTLEMENT_AUTHORITY_DENIED", 403, "RUN_SETTLEMENT is not grantable");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new AppError("CONFIRMATION_REQUIRED", 400, "Explicit confirmation is required");
  }
  return result.data;
}

function requireSettlement(deps: AppDeps) {
  if (!deps.settlement) {
    throw new AppError("NOT_FOUND", 404, "Settlement is not available");
  }
  return deps.settlement;
}

function auditFilter(c: Context<AppEnv>) {
  const limitRaw = c.req.query("limit");
  let limit = 50;
  if (limitRaw !== undefined) {
    if (!/^[0-9]+$/.test(limitRaw)) {
      throw new AppError("VALIDATION", 400, "limit must be an integer from 1 to 100");
    }
    limit = Number(limitRaw);
    if (limit < 1 || limit > 100) {
      throw new AppError("VALIDATION", 400, "limit must be an integer from 1 to 100");
    }
  }
  const actionRaw = c.req.query("action");
  const action = actionRaw && (AUDIT_EVENTS as readonly string[]).includes(actionRaw)
    ? actionRaw as (typeof AUDIT_EVENTS)[number]
    : undefined;
  if (actionRaw && !action) {
    throw new AppError("VALIDATION", 400, "Unknown audit action");
  }
  const from = parseTime(c.req.query("from"));
  const to = parseTime(c.req.query("to"));
  return {
    limit,
    actorAccountId: c.req.query("actor") || undefined,
    action,
    entityType: c.req.query("entityType") || undefined,
    entityId: c.req.query("entityId") || undefined,
    from,
    to,
    failuresOnly: c.req.query("failure") === "1",
    permissionDenialsOnly: c.req.query("denied") === "1",
  };
}

function parseTime(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) {
    throw new AppError("VALIDATION", 400, "time filter is invalid");
  }
  return time;
}

