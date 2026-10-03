/**
 * Audit event names. Phase 1 only emits ACCOUNT_LOGIN and ACCOUNT_LOGOUT.
 * The other names are constants for later phases. Emitting them from
 * unimplemented business flows is intentionally not wired.
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
