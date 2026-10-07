-- Phase 18D.2: Private Match Operations (operator-assisted scoring).
-- Additive. Does not weaken Phase 9 attestation or grant RUN_SETTLEMENT.
-- Operator-managed fixtures are NEVER Sportmonks. Historical match_events stay append-only.

-- Permission catalog: MANAGE_MATCH_OPERATIONS (CEO_HEAD + BACKEND_DEVELOPER only via app matrix).
ALTER TABLE permissions DROP CONSTRAINT IF EXISTS permissions_code_known;
ALTER TABLE permissions ADD CONSTRAINT permissions_code_known CHECK (code IN (
  'READ_SYSTEM',
  'READ_CONTEST',
  'READ_USER_HISTORY',
  'WRITE_SUPPORT_NOTE',
  'READ_AUDIT',
  'MANAGE_MATCH_CONFIG',
  'MANAGE_CONTEST_CONFIG',
  'MANAGE_MATCH_OPERATIONS',
  'REVIEW_RESULT',
  'RUN_SCORING',
  'RUN_SETTLEMENT',
  'MANAGE_RBAC',
  'MANAGE_SYSTEM'
));

INSERT INTO permissions (code, permission_group, description, created_at, updated_at)
VALUES (
  'MANAGE_MATCH_OPERATIONS',
  'OPERATE',
  'Private match ops: operator fixtures, credits, confirmed event entry. Not Sportmonks. Does not settle or move funds.',
  now(),
  now()
)
ON CONFLICT (code) DO NOTHING;

-- Audit actions for match ops mutations (append-only).
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
  'DEMO_MATCH_SEEDED',
  'DEMO_MATCH_ADVANCED',
  'DEMO_SCORING_WAVE',
  'DEMO_SCORE_REBUILD',
  'DEMO_FREE_FINALIZE',
  'LEAGUE_CREATED',
  'LEAGUE_JOINED',
  'LEAGUE_RESULT_FINALIZED',
  'PROFILE_UPDATED',
  'ONBOARDING_LEADERBOARD_VIEWED',
  'MATCH_OPS_FIXTURE_CREATED',
  'MATCH_OPS_FIXTURE_UPDATED',
  'MATCH_OPS_SQUAD_UPDATED',
  'MATCH_OPS_CREDIT_EDITED',
  'MATCH_OPS_EVENT_PROPOSED',
  'MATCH_OPS_EVENT_REVIEWED',
  'MATCH_OPS_EVENT_CONFIRMED',
  'MATCH_OPS_CORRECTION_APPENDED',
  'MATCH_OPS_DENIED'
));

-- Immutable credit edit log (previous/new/actor/reason). Never rewrites frozen team versions.
CREATE TABLE IF NOT EXISTS match_ops_credit_audits (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id),
  player_id uuid NOT NULL REFERENCES players (id),
  squad_row_id uuid NOT NULL,
  previous_credit bigint NOT NULL,
  new_credit bigint NOT NULL,
  actor_account_id uuid NOT NULL REFERENCES accounts (id),
  actor_role text NOT NULL,
  reason text NOT NULL,
  request_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_ops_credit_audits_range CHECK (
    previous_credit >= 0 AND previous_credit <= 20
    AND new_credit >= 1 AND new_credit <= 20
  ),
  CONSTRAINT match_ops_credit_audits_reason_len CHECK (char_length(reason) BETWEEN 3 AND 500)
);

CREATE INDEX IF NOT EXISTS match_ops_credit_audits_match_idx
  ON match_ops_credit_audits (match_id, created_at DESC);

COMMENT ON TABLE match_ops_credit_audits IS
  'Append-only credit edits for operator-managed fixtures. Does not rewrite fantasy_team_versions.';

-- Grok / operator event proposals. Confirmed rows publish into match_events; proposals never score alone.
CREATE TABLE IF NOT EXISTS match_ops_event_proposals (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id),
  status text NOT NULL,
  event_type text NOT NULL,
  primary_player_id uuid NOT NULL REFERENCES players (id),
  secondary_player_id uuid NULL REFERENCES players (id),
  match_minute integer NULL,
  note text NULL,
  source text NOT NULL,
  provenance text NOT NULL,
  proposed_by_account_id uuid NULL REFERENCES accounts (id),
  reviewed_by_account_id uuid NULL REFERENCES accounts (id),
  confirmed_by_account_id uuid NULL REFERENCES accounts (id),
  confirmed_event_id uuid NULL,
  provider_event_id text NOT NULL,
  request_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_ops_event_proposals_status_known CHECK (status IN (
    'PROPOSED', 'REVIEWED', 'CONFIRMED', 'REJECTED'
  )),
  CONSTRAINT match_ops_event_proposals_source_known CHECK (source IN (
    'MANUAL_OPERATOR', 'GROK_PROPOSED'
  )),
  CONSTRAINT match_ops_event_proposals_provenance_known CHECK (provenance IN (
    'MANUAL_OPERATOR', 'GROK_PROPOSED_MANUAL_CONFIRMED'
  )),
  CONSTRAINT match_ops_event_proposals_provider_event_unique UNIQUE (provider_event_id),
  CONSTRAINT match_ops_event_proposals_minute_range CHECK (
    match_minute IS NULL OR (match_minute >= 0 AND match_minute <= 130)
  )
);

CREATE INDEX IF NOT EXISTS match_ops_event_proposals_match_idx
  ON match_ops_event_proposals (match_id, status, created_at DESC);

COMMENT ON TABLE match_ops_event_proposals IS
  'Operator/Grok proposals. Scoring only after human CONFIRMED → match_events → LIVE_V1 pipeline.';

-- Append-only mutation audit for CEO review (before/after snapshots).
CREATE TABLE IF NOT EXISTS match_ops_mutation_audits (
  id uuid PRIMARY KEY,
  actor_account_id uuid NOT NULL REFERENCES accounts (id),
  actor_role text NOT NULL,
  action text NOT NULL,
  fixture_id uuid NULL REFERENCES matches (id),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb NOT NULL,
  reason text NULL,
  request_id text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT match_ops_mutation_audits_before_object CHECK (jsonb_typeof(before_state) = 'object'),
  CONSTRAINT match_ops_mutation_audits_after_object CHECK (jsonb_typeof(after_state) = 'object')
);

CREATE INDEX IF NOT EXISTS match_ops_mutation_audits_fixture_idx
  ON match_ops_mutation_audits (fixture_id, created_at DESC);

CREATE INDEX IF NOT EXISTS match_ops_mutation_audits_actor_idx
  ON match_ops_mutation_audits (actor_account_id, created_at DESC);

COMMENT ON TABLE match_ops_mutation_audits IS
  'Append-only Match Ops mutation log. No update/delete. CEO-reviewable.';
