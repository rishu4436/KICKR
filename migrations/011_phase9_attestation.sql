-- Phase 9 independent result attestation. Additive and backward-safe.
-- No custody columns. RUN_SETTLEMENT is not granted. Fee policy unchanged.
-- Sportmonks does not sign results unless its real API does; this table never claims it does.

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
  'ATTESTATION_REJECTED'
));

CREATE TABLE IF NOT EXISTS result_attestations (
  attestation_id uuid PRIMARY KEY,
  match_id uuid NOT NULL,
  contest_id uuid NOT NULL,
  scoring_ruleset_id text NOT NULL,
  scoring_ruleset_version integer NOT NULL,
  provider_source text NOT NULL,
  finalized_snapshot_hash text NOT NULL,
  result_hash text NOT NULL,
  issued_at timestamptz NOT NULL,
  attestor_id text NOT NULL,
  signature text NOT NULL,
  verification_status text NOT NULL,
  bound_settlement_id uuid NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT result_attestations_version_positive CHECK (
    (payload->>'version')::integer = 1
  ),
  CONSTRAINT result_attestations_ruleset_version_positive CHECK (scoring_ruleset_version >= 1),
  CONSTRAINT result_attestations_snapshot_hash_len CHECK (char_length(finalized_snapshot_hash) = 64),
  CONSTRAINT result_attestations_result_hash_len CHECK (char_length(result_hash) = 64),
  CONSTRAINT result_attestations_status_known CHECK (verification_status IN (
    'PENDING',
    'VERIFIED',
    'INVALID',
    'STALE',
    'MISSING'
  )),
  CONSTRAINT result_attestations_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

COMMENT ON TABLE result_attestations IS
  'Independent provider-neutral result attestations. Backend does not sign in production. Verification status is computed by the verifier, never operator-set as authority.';

CREATE UNIQUE INDEX IF NOT EXISTS result_attestations_contest_result_uidx
  ON result_attestations (contest_id, result_hash);

CREATE INDEX IF NOT EXISTS result_attestations_match_idx
  ON result_attestations (match_id);

CREATE INDEX IF NOT EXISTS result_attestations_attestor_idx
  ON result_attestations (attestor_id);
