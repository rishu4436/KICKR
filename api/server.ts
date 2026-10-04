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
import { loginRequestSchema, nonceRequestSchema } from "./schemas.js";
import { registerFootballRoutes } from "./football.js";
import { registerContestRoutes } from "./contests.js";
import { registerLiveRoutes } from "./live.js";
import { registerSettlementRoutes } from "./settlement.js";
import type { LiveScoringService } from "../live/service.js";
import type { SettlementService } from "../settlement/service.js";
import type { SettlementOrchestrator } from "../settlement/orchestrator.js";
import type { SnapshotStore } from "../live/snapshot.js";
import type { ContestService } from "../contests/service.js";
import type { FootballService } from "../football/service.js";
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
  contests: ContestService;
  live?: LiveScoringService;
  settlement?: SettlementService;
  settlementOrchestrator?: SettlementOrchestrator;
  snapshots?: SnapshotStore;
  redis: RedisClient;
  clientDir?: string;
  logger: Logger;
  clock: Clock;
  rateLimiter?: RateLimiter;
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_BODY_BYTES = 16_384;

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const incoming = c.req.header("x-request-id");
    const requestId =
      incoming && REQUEST_ID_PATTERN.test(incoming) ? incoming : crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("cache-control", "no-store");
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
  });

  app.onError((err, c) => {
    const correlationId = c.get("requestId") || "unknown";
    const normalized = err instanceof ZodError ? zodToAppError(err) : err;
    const mapped = toPublicError(normalized, deps.config.server.nodeEnv, correlationId);
    if (!(normalized instanceof AppError) || normalized.status >= 500) {
      deps.logger.error(
        redact({
          requestId: correlationId,
          name: normalized instanceof Error ? normalized.name : "Error",
          message: normalized instanceof Error ? normalized.message : "unknown",
        }) as Record<string, unknown>,
        "request failed",
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
    return c.json({
      ok: true,
      service: "kickr-api",
      LIVE_PROVIDER_CONFIGURED: deps.config.public.liveProviderConfigured,
    });
  });

  app.get("/ready", async (c) => {
    const redis = await checkRedisHealth(deps.redis);
    return c.json(
      {
        ok: redis.ok,
        redis,
        service: "kickr-api",
        LIVE_PROVIDER_CONFIGURED: deps.config.public.liveProviderConfigured,
      },
      redis.ok ? 200 : 503,
    );
  });

  app.get("/v1/config/public", (c) => {
    return c.json(deps.config.public);
  });

  app.post("/v1/auth/nonce", async (c) => {
    await consumeAuthRateLimit(deps, c);
    const body = nonceRequestSchema.parse(await readJson(c));
    const issued = await deps.auth.issueNonce(body.walletAddress, requestContext(deps, c));
    return c.json(issued, 201);
  });

  app.post("/v1/auth/login", async (c) => {
    await consumeAuthRateLimit(deps, c);
    const body = loginRequestSchema.parse(await readJson(c));
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

  if (deps.clientDir && existsSync(deps.clientDir)) {
    app.use("/assets/*", serveStatic({ root: deps.clientDir }));
    app.get("/", serveStatic({ root: deps.clientDir, path: "index.html" }));
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

async function consumeAuthRateLimit(deps: AppDeps, c: Context<AppEnv>): Promise<void> {
  if (!deps.rateLimiter) {
    return;
  }
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const key = `auth:${forwarded || "local"}`;
  const decision = await deps.rateLimiter.consume(key, deps.clock().getTime());
  if (!decision.allowed) {
    throw new AppError("RATE_LIMITED", 429, "Too many requests");
  }
}

function zodToAppError(err: ZodError): AppError {
  return new AppError("VALIDATION", 400, "Invalid input", {
    fields: err.issues.map((issue) => issue.path.join(".") || "body"),
  });
}
