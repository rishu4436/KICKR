/**
 * Audit event names. Phase 1 emits ACCOUNT_LOGIN and ACCOUNT_LOGOUT.
 * Phase 2 also emits TEAM_SAVED when a fantasy team version is stored.
 * Other names stay constants until their flows exist.
 */
export const AUDIT_EVENTS = [
  "ACCOUNT_LOGIN",
  "ACCOUNT_LOGOUT",
  "TEAM_SAVED",
  "JOIN_QUOTED",
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
