/**
 * Phase 8 counters and idempotency.
 * Counters exist only where a request already produced the event.
 * Idempotency keys are caller-supplied. This module never invents one
 * from a timestamp or a random value.
 */

import { AppError } from "./errors.js";

export const RELIABILITY_COUNTERS = [
  "rate_limit_hits",
  "auth_failures",
  "authz_failures",
  "reservation_conflicts",
  "deposit_verification_failures",
  "claim_reconcile_delays",
  "dependency_timeouts",
  "settlement_failures",
  "demo_control_actions",
  "scoring_rebuilds",
  "failed_api_requests",
] as const;

export type ReliabilityCounter = (typeof RELIABILITY_COUNTERS)[number];

export class ReliabilityCounters {
  private readonly counts = new Map<string, number>();

  hit(name: ReliabilityCounter): void {
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
  }

  snapshot(): Record<ReliabilityCounter, number> {
    const out = {} as Record<ReliabilityCounter, number>;
    for (const name of RELIABILITY_COUNTERS) {
      out[name] = this.counts.get(name) ?? 0;
    }
    return out;
  }
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replay: boolean;
}

export interface IdempotencyStore {
  run<T>(
    scope: string,
    key: string | null,
    requestHash: string,
    exec: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>>;
}

const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function parseIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined || header === "") {
    return null;
  }
  if (!KEY_PATTERN.test(header)) {
    throw new AppError("VALIDATION", 400, "Idempotency-Key is invalid");
  }
  return header;
}

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly rows = new Map<string, { hash: string; status: number; body: unknown }>();
  private readonly tail = new Map<string, Promise<void>>();

  async run<T>(
    scope: string,
    key: string | null,
    requestHash: string,
    exec: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    if (!key) {
      const result = await exec();
      return { ...result, replay: false };
    }
    const id = `${scope}\0${key}`;
    const previous = this.tail.get(id) ?? Promise.resolve();
    const run = previous.then(async () => {
      const existing = this.rows.get(id);
      if (existing) {
        if (existing.hash !== requestHash) {
          throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key was reused with a different request");
        }
        return { status: existing.status, body: existing.body as T, replay: true };
      }
      const result = await exec();
      this.rows.set(id, { hash: requestHash, status: result.status, body: result.body });
      return { ...result, replay: false };
    });
    this.tail.set(id, run.then(() => undefined, () => undefined));
    return run;
  }
}
