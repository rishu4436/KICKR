-- Phase 6.1.3: persist immutable result payload with settlement header for Postgres-backed API.
ALTER TABLE contest_settlements
  ADD COLUMN IF NOT EXISTS payload jsonb NULL;

COMMENT ON COLUMN contest_settlements.payload IS
  'Canonical KICKR_RESULT_V1 payload used for result_hash. Set at calculation; immutable after approval.';
