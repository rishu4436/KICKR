-- Phase 5.1 production correctness. Additive. No settlement, payouts, or USDC movement.
-- Snapshot boundary for Phase 6: approved snapshots are immutable and are not settlement.

ALTER TABLE match_score_snapshots
  ADD COLUMN IF NOT EXISTS contest_id uuid NULL REFERENCES contests (id),
  ADD COLUMN IF NOT EXISTS entry_id uuid NULL REFERENCES contest_entries (id),
  ADD COLUMN IF NOT EXISTS team_version_id uuid NULL REFERENCES fantasy_team_versions (id),
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'DRAFT',
  ADD COLUMN IF NOT EXISTS approved_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS data_finalization_state text NULL;

ALTER TABLE match_score_snapshots DROP CONSTRAINT IF EXISTS match_score_snapshots_status_known;
ALTER TABLE match_score_snapshots
  ADD CONSTRAINT match_score_snapshots_status_known CHECK (status IN ('DRAFT', 'APPROVED'));

ALTER TABLE match_score_snapshots DROP CONSTRAINT IF EXISTS match_score_snapshots_approval_consistency;
ALTER TABLE match_score_snapshots
  ADD CONSTRAINT match_score_snapshots_approval_consistency CHECK (
    (status = 'DRAFT' AND approved_at IS NULL)
    OR (status = 'APPROVED' AND approved_at IS NOT NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS match_score_snapshots_approved_entry_uq
  ON match_score_snapshots (entry_id)
  WHERE status = 'APPROVED' AND entry_id IS NOT NULL;

COMMENT ON TABLE match_score_snapshots IS
  'Phase 5.1 snapshot boundary. APPROVED rows are immutable. Settlement/payouts are not implemented here.';

CREATE OR REPLACE FUNCTION kickr_forbid_approved_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'approved match_score_snapshots are immutable; settlement is not implemented here'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' AND OLD.status = 'APPROVED' THEN
    RAISE EXCEPTION 'approved match_score_snapshots cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS match_score_snapshots_approved_guard ON match_score_snapshots;
CREATE TRIGGER match_score_snapshots_approved_guard
  BEFORE UPDATE OR DELETE ON match_score_snapshots
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_approved_snapshot_mutation();

-- Lineup sync diagnostics (unresolved players stay here; no fake player creation).
CREATE TABLE IF NOT EXISTS unresolved_lineup_players (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  match_id uuid NULL REFERENCES matches (id),
  external_fixture_id text NULL,
  external_player_id text NOT NULL,
  external_team_id text NULL,
  reason text NOT NULL,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT unresolved_lineup_players_payload_object CHECK (jsonb_typeof(raw_payload) = 'object')
);

CREATE INDEX IF NOT EXISTS unresolved_lineup_players_match_idx
  ON unresolved_lineup_players (match_id, created_at);
