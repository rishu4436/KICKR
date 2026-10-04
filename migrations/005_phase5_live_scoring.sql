-- Phase 5 live scoring. Additive. Does not rewrite Phase 1–4 tables.
-- Append-only match_events remains the canonical log. Settlement is not implemented.

ALTER TABLE match_events
  ADD COLUMN IF NOT EXISTS correction_type text NULL,
  ADD COLUMN IF NOT EXISTS provider_version text NULL,
  ADD COLUMN IF NOT EXISTS raw_event_hash text NULL;

ALTER TABLE match_events DROP CONSTRAINT IF EXISTS match_events_correction_type_known;
ALTER TABLE match_events
  ADD CONSTRAINT match_events_correction_type_known CHECK (
    correction_type IS NULL OR correction_type IN (
      'VAR_REVERSAL',
      'PROVIDER_CORRECTION',
      'SUPERSEDE'
    )
  );

CREATE INDEX IF NOT EXISTS match_events_match_occurred_idx
  ON match_events (match_id, occurred_at);

CREATE INDEX IF NOT EXISTS match_events_player_match_idx
  ON match_events (primary_player_id, match_id);

COMMENT ON COLUMN match_events.correction_type IS
  'Optional correction classifier. Original rows stay; corrections append with supersedes_event_id.';
COMMENT ON COLUMN match_events.provider_version IS
  'Provider payload version or feed revision when available.';
COMMENT ON COLUMN match_events.raw_event_hash IS
  'Hash of the normalized raw provider payload used for diagnostics and dedupe audits.';

-- Explicit provider → KICKR id map. Provider ids are never KICKR primary keys.
CREATE TABLE IF NOT EXISTS provider_id_map (
  provider text NOT NULL,
  entity_kind text NOT NULL,
  external_id text NOT NULL,
  kickr_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, entity_kind, external_id),
  CONSTRAINT provider_id_map_kind_known CHECK (entity_kind IN ('player', 'club', 'fixture'))
);

CREATE INDEX IF NOT EXISTS provider_id_map_kickr_idx ON provider_id_map (entity_kind, kickr_id);

COMMENT ON TABLE provider_id_map IS
  'Maps provider + external id to an existing KICKR uuid. Resolution never invents players.';

-- Unresolved provider facts that could not map to a KICKR player/club.
CREATE TABLE IF NOT EXISTS unresolved_provider_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  match_id uuid NULL REFERENCES matches (id),
  external_fixture_id text NULL,
  external_player_id text NULL,
  external_team_id text NULL,
  reason text NOT NULL,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unresolved_provider_events_payload_object CHECK (jsonb_typeof(raw_payload) = 'object'),
  CONSTRAINT unresolved_provider_events_unique UNIQUE (provider, provider_event_id, reason)
);

CREATE INDEX IF NOT EXISTS unresolved_provider_events_match_idx
  ON unresolved_provider_events (match_id, created_at);

-- Final score snapshot only. Settlement stays unimplemented.
CREATE TABLE IF NOT EXISTS match_score_snapshots (
  id uuid PRIMARY KEY,
  match_id uuid NOT NULL REFERENCES matches (id),
  ruleset_name text NOT NULL,
  ruleset_version integer NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT match_score_snapshots_snapshot_object CHECK (jsonb_typeof(snapshot) = 'object')
);

CREATE INDEX IF NOT EXISTS match_score_snapshots_match_idx
  ON match_score_snapshots (match_id, created_at DESC);

COMMENT ON TABLE match_score_snapshots IS
  'Phase 5 may store a final score snapshot during DATA_FINALIZING. It does not settle or pay winners.';

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_known;
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
  'SETTLEMENT_SUBMITTED',
  'PAYOUT_CLAIMED',
  'CONTEST_REFUNDED'
));
