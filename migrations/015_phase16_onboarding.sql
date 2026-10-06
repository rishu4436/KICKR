-- Phase 16: durable onboarding progress beyond one browser session.
-- Leaderboard-viewed is an explicit user event; XI/join derive from account state.
-- Dismissal preference stays client-side. No monetary columns.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS onboarding_leaderboard_viewed_at timestamptz NULL;

COMMENT ON COLUMN accounts.onboarding_leaderboard_viewed_at IS
  'Set when the account explicitly views a leaderboard during onboarding. Not inferred from join/live/final.';

-- Extend audit action allow-list for onboarding progress events.
ALTER TABLE audit_events DROP CONSTRAINT IF EXISTS audit_events_action_known;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_known CHECK (action IN (
  'ACCOUNT_LOGIN',
  'ACCOUNT_LOGOUT',
  'TEAM_SAVED',
  'CONTEST_CREATED',
  'CONTEST_FILLED',
  'JOIN_QUOTED',
  'ENTRY_RESERVED',
  'DEPOSIT_SUBMITTED',
  'DEPOSIT_VERIFIED',
  'DEPOSIT_REJECTED',
  'ENTRY_CONFIRMED',
  'ENTRY_REFUNDED',
  'CONTEST_LOCKED',
  'MATCH_EVENT_RECEIVED',
  'MATCH_EVENT_NORMALIZED',
  'MATCH_EVENT_REJECTED',
  'MATCH_EVENT_CORRECTED',
  'SCORE_RECOMPUTED',
  'REVIEW_APPROVED',
  'REVIEW_REJECTED',
  'RESULT_CALCULATED',
  'RESULT_RECALCULATED',
  'RESULT_REVIEWED',
  'RESULT_REJECTED',
  'RESULT_APPROVED',
  'SETTLEMENT_PREPARED',
  'SETTLEMENT_SUBMITTED',
  'SETTLEMENT_CONFIRMED',
  'SETTLEMENT_FAILED',
  'PAYOUT_CLAIMED',
  'REFUND_PREPARED',
  'REFUND_CLAIMED',
  'CONTEST_VOIDED',
  'CONTEST_REFUNDED',
  'ROLE_GRANTED',
  'ROLE_REMOVED',
  'CAPABILITY_GRANTED',
  'CAPABILITY_REMOVED',
  'ACCOUNT_SUSPENDED',
  'SESSION_REVOKED',
  'PERMISSION_DENIED',
  'ATTESTATION_ACCEPTED',
  'ATTESTATION_REJECTED',
  'LOCAL_DEV_SCORER_ISSUED',
  'LOCAL_DEV_FREE_FINALIZE',
  'LOCAL_DEV_MATCH_SEEDED',
  'LOCAL_DEV_MATCH_ADVANCED',
  'LEAGUE_CREATED',
  'LEAGUE_JOINED',
  'LEAGUE_RESULT_FINALIZED',
  'PROFILE_UPDATED',
  'ONBOARDING_LEADERBOARD_VIEWED'
));
