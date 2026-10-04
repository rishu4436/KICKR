/**
 * Audit event names. Phase 1 emits ACCOUNT_LOGIN and ACCOUNT_LOGOUT.
 * Phase 2 also emits TEAM_SAVED when a fantasy team version is stored.
 * Phase 3 emits CONTEST_CREATED, CONTEST_FILLED, CONTEST_LOCKED, JOIN_QUOTED,
 * and ENTRY_RESERVED. ENTRY_CONFIRMED stays a constant and is not emitted.
 * Other names stay constants until their flows exist.
 */
export const AUDIT_EVENTS = [
  "ACCOUNT_LOGIN",
  "ACCOUNT_LOGOUT",
  "TEAM_SAVED",
  "CONTEST_CREATED",
  "CONTEST_FILLED",
  "JOIN_QUOTED",
  "ENTRY_RESERVED",
  "ENTRY_CONFIRMED",
  "ENTRY_REFUNDED",
  "CONTEST_LOCKED",
  "SCORE_RECOMPUTED",
  "REVIEW_APPROVED",
  "REVIEW_REJECTED",
  "SETTLEMENT_SUBMITTED",
  "PAYOUT_CLAIMED",
  "CONTEST_REFUNDED",
] as const;

export type AuditEventName = (typeof AUDIT_EVENTS)[number];
