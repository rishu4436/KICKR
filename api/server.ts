import { Hono } from "hono";
import type { Context } from "hono";
import { ZodError } from "zod";
import type { AuditStore } from "../audit/types.js";
import type { AuthService } from "../auth/service.js";
import type { Principal } from "../auth/types.js";
import type { AppConfig } from "../config/types.js";
import { grantedPermissions } from "../rbac/authorize.js";
import type { GrantRepository } from "../rbac/grants.js";
import type { Permission } from "../rbac/permissions.js";
import { checkRedisHealth, type RedisClient } from "../redis/client.js";
import { AppError, toPublicError } from "../shared/errors.js";
import type { Logger } from "../shared/logger.js";
import { redact } from "../shared/redact.js";
import type { RateLimiter } from "../shared/rate-limit.js";
import type { Clock } from "../shared/clock.js";
import { InMemoryIdempotencyStore, ReliabilityCounters, type IdempotencyStore } from "../shared/reliability.js";
import { clientAddress, consumeLimit } from "./guard.js";
import { loginRequestSchema, nonceRequestSchema } from "./schemas.js";
import { registerFootballRoutes } from "./football.js";
import { registerContestRoutes } from "./contests.js";
import { registerLiveRoutes } from "./live.js";
import { registerSettlementRoutes } from "./settlement.js";
import { registerOpsRoutes } from "./ops.js";
import { registerDevE2eRoutes } from "./dev-e2e.js";
import { registerDemoControlRoutes } from "./demo-control.js";
import { registerLeagueRoutes } from "./leagues.js";
import { registerProfileRoutes } from "./profile.js";
import { registerSharePages } from "./share-pages.js";
import type { FootballStore } from "../football/store.js";
import type { LocalDevScoringActorRegistry } from "../contests/free/local-dev-scoring-actor.js";
import type { LiveScoringService } from "../live/service.js";
import type { SettlementService } from "../settlement/service.js";
import type { ClaimObservation } from "../settlement/verify.js";
import type { SettlementOrchestrator } from "../settlement/orchestrator.js";
import type { SnapshotStore } from "../live/snapshot.js";
import type { AttestationStore } from "../attestation/types.js";
import type { SettlementAttestationGate } from "../attestation/gate.js";
import type { ContestService } from "../contests/service.js";
import type { FootballService } from "../football/service.js";
import type { LeagueService } from "../leagues/service.js";
import type { ProfileService } from "../profile/service.js";
import type { OnboardingService } from "../profile/onboarding.js";
import { detectForbiddenSignerEnv, evaluateDemoReady } from "../ops/demo-ready.js";
import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";

export type AppEnv = {
  Variables: {
    requestId: string;
    principal?: Principal;
  };
};

export interface AppDeps {
  config: AppConfig;
  auth: AuthService;
  grants: GrantRepository;
  audit: AuditStore;
  football: FootballService;
  /** Present when Postgres-backed; required by the local-dev E2E harness. */
  footballStore?: FootballStore;
  contests: ContestService;
  leagues?: LeagueService;
  profiles?: ProfileService;
  onboarding?: OnboardingService;
  /** Dev-only LOCAL_DEV scoring actor registry. Absent / empty in production. */
  scoringActors?: LocalDevScoringActorRegistry;
  live?: LiveScoringService;
  settlement?: SettlementService;
  settlementOrchestrator?: SettlementOrchestrator;
  snapshots?: SnapshotStore;
  attestations?: AttestationStore;
  attestationGate?: SettlementAttestationGate;
  redis: RedisClient;
  clientDir?: string;
  logger: Logger;
  clock: Clock;
  rateLimiter?: RateLimiter;
  counters?: ReliabilityCounters;
  idempotency?: IdempotencyStore;
  probes?: {
    database?: () => Promise<boolean>;
    solana?: () => Promise<boolean>;
    sports?: () => Promise<{ configured: boolean; reachable: boolean | null }>;
  };
  /** Test seam. Production uses observeFinalizedClaim. */
  claimObserver?: (
    rpcUrl: string,
    signature: string,
    programId: string,
  ) => Promise<ClaimObservation | null>;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BODY_BYTES = 16_384;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  if (!deps.counters) {
    deps.counters = new ReliabilityCounters();
  }
  if (!deps.idempotency) {
    deps.idempotency = new InMemoryIdempotencyStore();
  }
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId =
      incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
    c.header("content-security-policy", "frame-ancestors 'none'");
    c.header("permissions-policy", "interest-cohort=()");
    c.header("cache-control", "no-store");
    const origin = c.req.header("origin");
    if (origin && deps.config.server.origins.includes(origin)) {
      c.header("access-control-allow-origin", origin);
      c.header("vary", "Origin");
      c.header("access-control-allow-headers", "authorization, content-type, idempotency-key, x-request-id");
      c.header("access-control-allow-methods", "GET, POST, PATCH, OPTIONS");
    }
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    const started = Date.now();
    try {
      await next();
    } finally {
      deps.logger.info(
        {
          requestId,
          method: c.req.method,
          path: c.req.path,
          status: c.res.status,
          durationMs: Date.now() - started,
        },
        "request",
      );
    }
    return;
  });

  app.onError((err, c) => {
    const correlationId = c.get("requestId") || "unknown";
    const normalized = err instanceof ZodError ? zodToAppError(err) : err;
    const mapped = toPublicError(normalized, deps.config.server.nodeEnv, correlationId);
    if (normalized instanceof AppError) {
      if (normalized.status === 401) {
        deps.counters?.hit("auth_failures");
      } else if (normalized.status === 403) {
        deps.counters?.hit("authz_failures");
      } else if (normalized.code === "DUPLICATE_ENTRY" || normalized.code === "DUPLICATE_RESERVATION" || normalized.code === "CONTEST_FULL") {
        deps.counters?.hit("reservation_conflicts");
      } else if (normalized.code === "SETTLEMENT_FAILED") {
        deps.counters?.hit("settlement_failures");
      }
    }
    deps.counters?.hit("failed_api_requests");
    if (!(normalized instanceof AppError) || normalized.status >= 500) {
      deps.logger.error(
        redact({
          requestId: correlationId,
          name: normalized instanceof Error ? normalized.name : "Error",
          message: normalized instanceof Error ? normalized.message : "unknown",
          status: normalized instanceof AppError ? normalized.status : 500,
        }) as Record<string, unknown>,
        "request failed",
      );
    } else {
      deps.logger.warn(
        redact({
          requestId: correlationId,
          code: normalized.code,
          status: normalized.status,
          path: c.req.path,
        }) as Record<string, unknown>,
        "request error",
      );
    }
    return c.json(mapped.body, mapped.status as 400);
  });

  app.notFound((c) => {
    return c.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Not found",
          correlationId: c.get("requestId") || "unknown",
        },
      },
      404,
    );
  });

  app.get("/health", (c) => {
    const tokenOk = (deps.config.server.sportsData.demoControlToken ?? "").trim().length >= 16;
    const appMode = deps.config.server.sportsData.appMode;
    const demoControlConfigured =
      tokenOk &&
      appMode !== "LIVE" &&
      (appMode === "DEMO" ||
        appMode === "DUAL" ||
        deps.config.public.sportsProvider === "demo");
    return c.json({
      ok: true,
      check: "live",
      service: "kickr-api",
      LIVE_PROVIDER_CONFIGURED: deps.config.public.liveProviderConfigured,
      sportsProvider: deps.config.public.sportsProvider,
      demoData: deps.config.public.demoData,
      dualMode: deps.config.public.dualMode,
      appMode: deps.config.public.appMode,
      modesAvailable: deps.config.public.modesAvailable,
      liveFixtureId: deps.config.public.liveFixtureId,
      demoControlConfigured,
      counters: deps.counters?.snapshot() ?? null,
    });
  });

  app.get("/ready", async (c) => {
    const report = await dependencyReport(deps);
    return c.json(
      {
        ok: report.ready,
        check: "ready",
        redis: report.dependencies.redis,
        database: report.dependencies.database,
        startupConfig: report.dependencies.startupConfig,
        service: "kickr-api",
        LIVE_PROVIDER_CONFIGURED: deps.config.public.liveProviderConfigured,
      },
      report.ready ? 200 : 503,
    );
  });

  app.get("/ready/demo", async (c) => {
    const reportDeps = await dependencyReport(deps);
    const forbidden = detectForbiddenSignerEnv(process.env);
    const demoReport = evaluateDemoReady({
      config: deps.config,
      databaseOk: reportDeps.dependencies.database.ok,
      redisOk: reportDeps.dependencies.redis.ok,
      hasDevSignerEnv: forbidden.length > 0,
      hasBackendUsdcCustody: forbidden.some((k) => k.includes("USDC") || k.includes("ESCROW")),
      // Production wires allowPaidDevnet=false in api/main.ts.
      paidProductionEnabled: deps.config.server.nodeEnv === "production" ? false : false,
    });
    return c.json(
      {
        ok: demoReport.ok && reportDeps.ready,
        check: "demo-ready",
        mode: demoReport.mode,
        checks: demoReport.checks,
        forbiddenSignerEnv: forbidden,
        database: reportDeps.dependencies.database,
        redis: reportDeps.dependencies.redis,
        freeOnly: true,
        paidProductionEnabled: false,
        LIVE_PROVIDER_CONFIGURED: deps.config.public.liveProviderConfigured,
        demoData: deps.config.public.demoData,
      },
      demoReport.ok && reportDeps.ready ? 200 : 503,
    );
  });


  app.get("/health/dependencies", async (c) => {
    const report = await dependencyReport(deps);
    return c.json(report, report.live ? 200 : 503);
  });

  app.post("/v1/dev/fixtures/load", (c) => {
    if (deps.config.server.nodeEnv === "production") {
      throw new AppError("FIXTURE_DISABLED", 404, "Fixture routes are not available");
    }
    return c.json({
      ok: true,
      loaded: false,
      isolated: true,
      note: "Fixture catalogs stay out of production runtime and are not loaded here.",
    });
  });

  app.get("/v1/config/public", (c) => {
    return c.json(deps.config.public);
  });

  app.post("/v1/auth/nonce", async (c) => {
    const body = nonceRequestSchema.parse(await readJson(c));
    await consumeLimit(deps, c, "auth-nonce", `${clientAddress(c)}:${body.walletAddress}`);
    const issued = await deps.auth.issueNonce(body.walletAddress, requestContext(deps, c));
    return c.json(issued, 201);
  });

  app.post("/v1/auth/login", async (c) => {
    const body = loginRequestSchema.parse(await readJson(c));
    await consumeLimit(deps, c, "auth-login", `${clientAddress(c)}:${body.walletAddress}`);
    const result = await deps.auth.login(body, requestContext(deps, c));
    return c.json(result, 200);
  });

  app.post("/v1/auth/logout", async (c) => {
    const token = bearerToken(c);
    const principal = await deps.auth.logout(token, requestContext(deps, c));
    return c.json({ ok: true, accountId: principal.accountId });
  });

  app.get("/v1/me", async (c) => {
    const principal = await authenticate(deps, c);
    return c.json({
      accountId: principal.accountId,
      walletAddress: principal.walletAddress,
      sessionId: principal.sessionId,
      expiresAt: principal.expiresAt.toISOString(),
    });
  });

  app.get("/v1/me/permissions", async (c) => {
    const principal = await authenticate(deps, c);
    const grants = await loadGrants(deps, principal.accountId);
    return c.json({
      roles: grants.roles,
      capabilities: grants.capabilities,
      permissions: [...grantedPermissions(grants)].sort(),
    });
  });

  app.get("/v1/system/status", async (c) => {
    await authenticate(deps, c);
    await requirePermission(deps, c, "READ_SYSTEM");
    return c.json({ ok: true, service: "kickr-api" });
  });

  app.get("/v1/audit/events", async (c) => {
    await authenticate(deps, c);
    await requirePermission(deps, c, "READ_AUDIT");
    const events = await deps.audit.list(parseLimit(c));
    return c.json({
      events: events.map((event) => ({
        id: event.id,
        action: event.action,
        occurredAt: event.occurredAt.toISOString(),
        entityType: event.entityType,
        entityId: event.entityId,
        metadata: event.metadata,
        actorAccountId: event.actorAccountId,
        actorWallet: event.actorWallet,
        correlationId: event.correlationId,
      })),
    });
  });

  registerFootballRoutes(app, deps, (c) => authenticate(deps, c));
  registerContestRoutes(app, deps, (c) => authenticate(deps, c), (c, permission) => requirePermission(deps, c, permission));
  registerLiveRoutes(
    app,
    deps,
    (c) => authenticate(deps, c),
    async (c, permission) => requirePermission(deps, c, permission),
  );
  registerSettlementRoutes(
    app,
    deps,
    (c) => authenticate(deps, c),
    (c, permission) => requirePermission(deps, c, permission),
  );
  registerOpsRoutes(app, deps, (c) => authenticate(deps, c));
  registerDevE2eRoutes(app, deps, (c) => authenticate(deps, c));
  registerDemoControlRoutes(app, deps);
  registerLeagueRoutes(app, deps, (c) => authenticate(deps, c));
  registerProfileRoutes(app, deps, (c) => authenticate(deps, c));
  registerSharePages(app, deps);

  if (deps.clientDir && existsSync(deps.clientDir)) {
    app.use("/assets/*", serveStatic({ root: deps.clientDir }));
    app.get("/", serveStatic({ root: deps.clientDir, path: "index.html" }));
    app.get("/ops", serveStatic({ root: deps.clientDir, path: "ops.html" }));
    app.get("/ops/", serveStatic({ root: deps.clientDir, path: "ops.html" }));
  }

  return app;
}

function requestContext(deps: AppDeps, c: Context<AppEnv>) {
  return {
    now: deps.clock(),
    correlationId: c.get("requestId") ?? null,
  };
}

async function readJson(c: Context<AppEnv>): Promise<unknown> {
  const text = await c.req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new AppError("VALIDATION", 400, "Body too large");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new AppError("VALIDATION", 400, "Body must be JSON");
  }
}

function bearerToken(c: Context<AppEnv>): string {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
  }
  const token = header.slice("Bearer ".length).trim();
  if (!token) {
    throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
  }
  return token;
}

async function authenticate(deps: AppDeps, c: Context<AppEnv>): Promise<Principal> {
  const existing = c.get("principal");
  if (existing) {
    return existing;
  }
  const principal = await deps.auth.authenticate(bearerToken(c), requestContext(deps, c));
  c.set("principal", principal);
  return principal;
}

async function loadGrants(deps: AppDeps, accountId: string) {
  const [roles, capabilities] = await Promise.all([
    deps.grants.listRoles(accountId),
    deps.grants.listCapabilities(accountId),
  ]);
  return { roles, capabilities };
}

async function requirePermission(
  deps: AppDeps,
  c: Context<AppEnv>,
  permission: Permission,
): Promise<void> {
  const principal = c.get("principal");
  if (!principal) {
    throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
  }
  const grants = await loadGrants(deps, principal.accountId);
  if (!grantedPermissions(grants).has(permission)) {
    await deps.audit.append({
      action: "PERMISSION_DENIED",
      occurredAt: deps.clock(),
      entityType: "ROUTE",
      entityId: c.req.path.slice(0, 128),
      metadata: { result: "denied", permission },
      actorAccountId: principal.accountId,
      actorWallet: principal.walletAddress,
      correlationId: c.get("requestId") ?? null,
    });
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }
}

function parseLimit(c: Context<AppEnv>): number {
  const raw = c.req.query("limit");
  if (raw === undefined) {
    return 50;
  }
  if (!/^[0-9]+$/.test(raw)) {
    throw new AppError("VALIDATION", 400, "limit must be an integer from 1 to 100");
  }
  const limit = Number(raw);
  if (limit < 1 || limit > 100) {
    throw new AppError("VALIDATION", 400, "limit must be an integer from 1 to 100");
  }
  return limit;
}

function zodToAppError(err: ZodError): AppError {
  return new AppError("VALIDATION", 400, "Invalid input", {
    fields: err.issues.map((issue) => issue.path.join(".") || "body"),
  });
}


async function dependencyReport(deps: AppDeps): Promise<{
  live: boolean;
  ready: boolean;
  dependencies: {
    database: { ok: boolean; skipped?: boolean };
    redis: { ok: boolean; latencyMs: number };
    sports: { ok: boolean; configured: boolean; reachable: boolean | null };
    solanaRpc: { ok: boolean; skipped?: boolean };
    startupConfig: { ok: boolean };
  };
}> {
  const redis = await checkRedisHealth(deps.redis);
  if (!redis.ok) {
    deps.counters?.hit("dependency_timeouts");
  }
  let database: { ok: boolean; skipped?: boolean } = { ok: true, skipped: true };
  if (deps.probes?.database) {
    try {
      database = { ok: await deps.probes.database() };
    } catch {
      database = { ok: false };
    }
    if (!database.ok) {
      deps.counters?.hit("dependency_timeouts");
    }
  }
  let solanaRpc: { ok: boolean; skipped?: boolean } = { ok: true, skipped: true };
  if (deps.probes?.solana) {
    try {
      solanaRpc = { ok: await deps.probes.solana() };
    } catch {
      solanaRpc = { ok: false };
      deps.counters?.hit("dependency_timeouts");
    }
  }
  const sportsProbe = deps.probes?.sports
    ? await deps.probes.sports().catch(() => ({ configured: deps.config.public.liveProviderConfigured, reachable: false as boolean | null }))
    : { configured: deps.config.public.liveProviderConfigured, reachable: null as boolean | null };
  const sportsOk = !sportsProbe.configured || sportsProbe.reachable !== false;
  const startupOk = Boolean(deps.config.secrets.databaseUrl && deps.config.secrets.redisUrl && deps.config.server.auth.domain);
  const ready = redis.ok && database.ok && startupOk;
  return {
    live: true,
    ready,
    dependencies: {
      database,
      redis,
      sports: { ok: sportsOk, configured: sportsProbe.configured, reachable: sportsProbe.reachable },
      solanaRpc,
      startupConfig: { ok: startupOk },
    },
  };
}
