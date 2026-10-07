-- Phase 18C: Sportmonks live integration.
-- Durable player stat observations for cumulative SHOT_ON_TARGET synthesis.
-- Redis may cache latest totals but must NOT be the only durable state.
-- Append-only match_events remain the scoring log. Settlement/attestation unchanged.

CREATE TABLE IF NOT EXISTS player_stat_observations (
  fixture_id text NOT NULL,
  player_id text NOT NULL,
  stat_type text NOT NULL,
  observed_total integer NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (fixture_id, player_id, stat_type),
  CONSTRAINT player_stat_observations_total_nonneg CHECK (observed_total >= 0),
  CONSTRAINT player_stat_observations_stat_known CHECK (stat_type IN ('SHOT_ON_TARGET'))
);

CREATE INDEX IF NOT EXISTS player_stat_observations_fixture_idx
  ON player_stat_observations (fixture_id);

COMMENT ON TABLE player_stat_observations IS
  'Phase 18C durable cumulative provider stats (e.g. Sportmonks shots-on-target). Used to synthesize append-only SHOT_ON_TARGET match_events. Redis is cache only.';

-- Allow PROVIDER_CORRECTION already present from Phase 5. No audit action changes required.
