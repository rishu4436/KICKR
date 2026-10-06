import type { Context } from "hono";
import { AppError } from "../shared/errors.js";
import { sha256Hex } from "../shared/ids.js";
import { parseIdempotencyKey } from "../shared/reliability.js";
import type { AppDeps, AppEnv } from "./server.js";

const PROTECTED = new Set([
  "reservation",
  "deposit",
  "claim-submit",
  "claim-reconcile",
  "ops",
  "settlement",
]);

export function requestHash(value: unknown): string {
  return sha256Hex(stable(value));
}

function stable(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stable(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${stable(inner)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function clientAddress(c: Context<AppEnv>): string {
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && /^[A-Za-z0-9.:]{1,64}$/.test(forwarded) ? forwarded : "local";
}

/**
 * Auth routes keep the Phase 1 optional limiter: a missing limiter does not
 * block login, matching the existing guard. A thrown limiter fails closed.
 * Protected mutations fail closed in production when the limiter is missing,
 * and fail closed in every environment when the limiter throws.
 */
export async function consumeLimit(
  deps: AppDeps,
  c: Context<AppEnv>,
  scope: string,
  key: string,
): Promise<void> {
  const limiter = deps.rateLimiter;
  if (!limiter) {
    if (PROTECTED.has(scope) && deps.config.server.nodeEnv === "production") {
      deps.counters?.hit("dependency_timeouts");
      throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Rate limiter unavailable", { expose: true });
    }
    return;
  }
  let decision: { allowed: boolean };
  try {
    decision = await limiter.consume(`${scope}:${key}`, deps.clock().getTime());
  } catch {
    deps.counters?.hit("dependency_timeouts");
    throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Rate limiter unavailable", { expose: true });
  }
  if (!decision.allowed) {
    deps.counters?.hit("rate_limit_hits");
    deps.logger.warn({ requestId: c.get("requestId"), scope }, "rate limited");
    throw new AppError("RATE_LIMITED", 429, "Too many requests");
  }
}

export async function replayOrRun<T>(
  deps: AppDeps,
  c: Context<AppEnv>,
  scope: string,
  request: unknown,
  exec: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replay: boolean }> {
  const store = deps.idempotency;
  if (!store) {
    const result = await exec();
    return { ...result, replay: false };
  }
  const key = parseIdempotencyKey(c.req.header("idempotency-key"));
  return store.run(scope, key, requestHash(request), exec);
}
