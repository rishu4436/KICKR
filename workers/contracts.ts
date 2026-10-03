/**
 * Phase 1 service contracts only.
 * Nothing in this module starts a process, reads a sports feed, scores a
 * contest, settles a contest, or moves USDC.
 *
 * The Solana escrow program does NOT exist in Phase 1.
 * Future escrow movement must never depend on a backend private key that can
 * arbitrarily move the contest pot. No such key is configured.
 */

export const PHASE1_WORKER_STATUS = "contracts-only" as const;

export interface IndexerContract {
  readonly name: "indexer";
  readonly phase1: typeof PHASE1_WORKER_STATUS;
}

export interface SchedulerContract {
  readonly name: "scheduler";
  readonly phase1: typeof PHASE1_WORKER_STATUS;
}

export interface ScoringWorkerContract {
  readonly name: "scoring-worker";
  readonly phase1: typeof PHASE1_WORKER_STATUS;
  /** Does not grant escrow access. */
  readonly permission: "RUN_SCORING";
}

export interface ReviewToolContract {
  readonly name: "review-tool";
  readonly phase1: typeof PHASE1_WORKER_STATUS;
  readonly permission: "REVIEW_RESULT";
}

export interface SettlementWorkerContract {
  readonly name: "settlement-worker";
  readonly phase1: typeof PHASE1_WORKER_STATUS;
  readonly permission: "RUN_SETTLEMENT";
}

export interface SupportConsoleContract {
  readonly name: "support-console";
  readonly phase1: typeof PHASE1_WORKER_STATUS;
}

export interface MonitoringContract {
  readonly name: "monitoring";
  readonly phase1: typeof PHASE1_WORKER_STATUS;
}

/**
 * The HTTP API is the only service with an entrypoint in Phase 1.
 * These names exist so later processes can be split out without reshaping
 * the account, session, RBAC, and audit foundation.
 */
export const FUTURE_SERVICE_NAMES = [
  "api",
  "indexer",
  "scheduler",
  "scoring-worker",
  "review-tool",
  "settlement-worker",
  "support-console",
  "monitoring",
] as const;
