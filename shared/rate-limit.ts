/**
 * Rate-limit abstraction.
 * The in-memory implementation is for tests and a single-process auth guard.
 * TODO: a product rate-limit policy for contests is unspecified and is not defined here.
 * TODO: the numeric auth-route defaults in config are temporary infrastructure
 * placeholders, not a product decision.
 */

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
}

export interface RateLimiter {
  consume(key: string, nowMs?: number): Promise<RateLimitDecision>;
}

export class InMemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("rate limit must be a positive integer");
    }
    if (!Number.isInteger(windowMs) || windowMs < 1) {
      throw new Error("rate limit window must be a positive integer");
    }
  }

  async consume(key: string, nowMs = Date.now()): Promise<RateLimitDecision> {
    const current = this.hits.get(key);
    if (!current || nowMs - current.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return { allowed: true, limit: this.limit, remaining: this.limit - 1 };
    }
    if (current.count >= this.limit) {
      return { allowed: false, limit: this.limit, remaining: 0 };
    }
    current.count += 1;
    return {
      allowed: true,
      limit: this.limit,
      remaining: this.limit - current.count,
    };
  }
}
