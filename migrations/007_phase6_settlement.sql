-- Phase 6 settlement. Additive. Program remains USDC authority.
-- Backend never stores a private key that can move vault funds arbitrarily.
-- Fees stay labelled DEV (1000 bps) from frozen fee_policies.

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
  'CONTEST_REFUNDED'
));

-- Explicit Phase 6 payout calculations (version 2). Version 1 stays historical.
INSERT INTO payout_policies (id, version, policy_type, configuration, created_at) VALUES
  (
    '52000000-0000-4000-8000-000000000001',
    2,
    'HEAD_TO_HEAD',
    '{"shape":"HEAD_TO_HEAD","calculation":"winner_takes_prize_pool","tiePolicy":"entry_id_asc","note":"DEV Phase 6. Winner gets 100% of prize pool after fees. Tiebreak: lower entry_id ranks higher."}'::jsonb,
    '2026-10-04T00:00:00.000Z'
  ),
  (
    '52000000-0000-4000-8000-000000000002',
    2,
    'WINNER_TAKES_ALL',
    '{"shape":"WINNER_TAKES_ALL","calculation":"winner_takes_prize_pool","tiePolicy":"entry_id_asc","note":"DEV Phase 6. Rank 1 gets 100% of prize pool after fees. Tiebreak: entry_id_asc."}'::jsonb,
    '2026-10-04T00:00:00.000Z'
  ),
  (
    '52000000-0000-4000-8000-000000000003',
    2,
    'GRAND_LEAGUE',
    '{"shape":"GRAND_LEAGUE","calculation":"rank_bps","tiePolicy":"entry_id_asc","ranks":[{"rank":1,"bps":4000},{"rank":2,"bps":3000},{"rank":3,"bps":2000},{"rank":4,"bps":1000}],"note":"DEV Phase 6 schedule. Sum of rank bps = 10000 of prize pool. Not a production schedule."}'::jsonb,
    '2026-10-04T00:00:00.000Z'
  );

UPDATE contest_templates
SET payout_policy_version = 2, updated_at = '2026-10-04T00:00:00.000Z'
WHERE payout_policy_id IN (
  '52000000-0000-4000-8000-000000000001',
  '52000000-0000-4000-8000-000000000002',
  '52000000-0000-4000-8000-000000000003'
);

CREATE TABLE contest_settlements (
  id uuid PRIMARY KEY,
  contest_id uuid NOT NULL REFERENCES contests (id),
  match_id uuid NOT NULL REFERENCES matches (id),
  settlement_version integer NOT NULL,
  status text NOT NULL,
  result_hash text NOT NULL,
  merkle_root text NULL,
  settlement_hash text NULL,
  calculation_version integer NOT NULL,
  fee_policy_id uuid NOT NULL,
  fee_policy_version integer NOT NULL,
  fee_rate_bps integer NOT NULL,
  payout_policy_id uuid NOT NULL,
  payout_policy_version integer NOT NULL,
  payout_policy_type text NOT NULL,
  payout_configuration jsonb NOT NULL,
  ruleset_name text NOT NULL,
  ruleset_version integer NOT NULL,
  entry_fee_base_units bigint NOT NULL,
  seat_count integer NOT NULL,
  confirmed_entries integer NOT NULL,
  total_pot_base_units bigint NOT NULL,
  fee_base_units bigint NOT NULL,
  total_payout_base_units bigint NOT NULL,
  commit_signature text NULL,
  confirmed_slot bigint NULL,
  confirmed_at timestamptz NULL,
  failure_reason text NULL,
  approved_by uuid NULL REFERENCES accounts (id),
  approved_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT contest_settlements_version_positive CHECK (settlement_version >= 1),
  CONSTRAINT contest_settlements_calc_positive CHECK (calculation_version >= 1),
  CONSTRAINT contest_settlements_status_known CHECK (status IN (
    'RESULT_CALCULATED',
    'RESULT_REVIEWED',
    'RESULT_REJECTED',
    'RESULT_APPROVED',
    'SETTLEMENT_APPROVED',
    'SETTLEMENT_PREPARED',
    'SETTLEMENT_SUBMITTED',
    'SETTLEMENT_CONFIRMED',
    'SETTLEMENT_FAILED',
    'VOIDED'
  )),
  CONSTRAINT contest_settlements_amounts_nonnegative CHECK (
    entry_fee_base_units >= 0
    AND total_pot_base_units >= 0
    AND fee_base_units >= 0
    AND total_payout_base_units >= 0
  ),
  CONSTRAINT contest_settlements_fee_labelled_dev CHECK (fee_rate_bps >= 0),
  CONSTRAINT contest_settlements_contest_version_uq UNIQUE (contest_id, settlement_version)
);

COMMENT ON TABLE contest_settlements IS
  'Off-chain settlement lifecycle. On-chain commit/claim is authoritative for USDC. SUBMITTED is not CONFIRMED.';

CREATE TABLE settlement_result_rows (
  id uuid PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES contest_settlements (id),
  contest_id uuid NOT NULL REFERENCES contests (id),
  entry_id uuid NOT NULL REFERENCES contest_entries (id),
  team_version_id uuid NOT NULL REFERENCES fantasy_team_versions (id),
  destination_wallet text NOT NULL,
  rank integer NOT NULL,
  base_score_milli_points bigint NOT NULL,
  final_score_milli_points bigint NOT NULL,
  result_status text NOT NULL,
  xi jsonb NOT NULL,
  captain_id uuid NOT NULL,
  vice_id uuid NOT NULL,
  gross_allocation_base_units bigint NOT NULL,
  fee_allocation_base_units bigint NOT NULL,
  net_payout_base_units bigint NOT NULL,
  leaf_hash text NOT NULL,
  claim_status text NOT NULL DEFAULT 'UNCLAIMED',
  claim_signature text NULL,
  claimed_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT settlement_result_rows_rank_positive CHECK (rank >= 1),
  CONSTRAINT settlement_result_rows_amounts_nonnegative CHECK (
    gross_allocation_base_units >= 0
    AND fee_allocation_base_units >= 0
    AND net_payout_base_units >= 0
  ),
  CONSTRAINT settlement_result_rows_status_known CHECK (
    result_status IN ('RANKED', 'VOID', 'INELIGIBLE')
  ),
  CONSTRAINT settlement_result_rows_claim_known CHECK (
    claim_status IN ('UNCLAIMED', 'SUBMITTED', 'CLAIMED', 'FAILED')
  ),
  CONSTRAINT settlement_result_rows_entry_uq UNIQUE (settlement_id, entry_id)
);

CREATE UNIQUE INDEX settlement_result_rows_approved_entry_uq
  ON settlement_result_rows (entry_id, settlement_id);

CREATE TABLE settlement_reconciliations (
  id uuid PRIMARY KEY,
  settlement_id uuid NOT NULL REFERENCES contest_settlements (id),
  signature text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT settlement_reconciliations_kind_known CHECK (
    kind IN ('COMMIT', 'CLAIM', 'REFUND', 'VOID')
  ),
  CONSTRAINT settlement_reconciliations_status_known CHECK (
    status IN ('CONFIRMED', 'REJECTED', 'PENDING')
  )
);

CREATE UNIQUE INDEX settlement_reconciliations_signature_uq
  ON settlement_reconciliations (signature);

COMMENT ON TABLE settlement_reconciliations IS
  'Independent verification of finalized Solana txs. A failed RPC must not mark funds settled.';

-- Immutable guard: approved settlement result rows must not be mutated.
CREATE OR REPLACE FUNCTION kickr_forbid_approved_settlement_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_status text;
BEGIN
  SELECT status INTO parent_status FROM contest_settlements WHERE id = OLD.settlement_id;
  IF parent_status IN ('RESULT_APPROVED', 'SETTLEMENT_APPROVED', 'SETTLEMENT_PREPARED', 'SETTLEMENT_SUBMITTED', 'SETTLEMENT_CONFIRMED') THEN
    IF TG_OP = 'DELETE' THEN
      RAISE EXCEPTION 'approved settlement result rows cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    IF TG_OP = 'UPDATE' THEN
      IF NEW.rank IS DISTINCT FROM OLD.rank
         OR NEW.net_payout_base_units IS DISTINCT FROM OLD.net_payout_base_units
         OR NEW.destination_wallet IS DISTINCT FROM OLD.destination_wallet
         OR NEW.final_score_milli_points IS DISTINCT FROM OLD.final_score_milli_points
         OR NEW.team_version_id IS DISTINCT FROM OLD.team_version_id
         OR NEW.leaf_hash IS DISTINCT FROM OLD.leaf_hash THEN
        RAISE EXCEPTION 'approved settlement ranking/payout fields are immutable'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS settlement_result_rows_approved_guard ON settlement_result_rows;
CREATE TRIGGER settlement_result_rows_approved_guard
  BEFORE UPDATE OR DELETE ON settlement_result_rows
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_approved_settlement_mutation();

CREATE OR REPLACE FUNCTION kickr_forbid_approved_settlement_header_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('RESULT_APPROVED', 'SETTLEMENT_APPROVED', 'SETTLEMENT_PREPARED', 'SETTLEMENT_SUBMITTED', 'SETTLEMENT_CONFIRMED') THEN
    IF NEW.result_hash IS DISTINCT FROM OLD.result_hash
       OR NEW.settlement_version IS DISTINCT FROM OLD.settlement_version
       OR NEW.merkle_root IS DISTINCT FROM OLD.merkle_root AND OLD.merkle_root IS NOT NULL
       OR NEW.total_payout_base_units IS DISTINCT FROM OLD.total_payout_base_units
       OR NEW.fee_base_units IS DISTINCT FROM OLD.fee_base_units THEN
      -- Allow merkle_root set once during prepare, and status/signature progression.
      IF NEW.result_hash IS DISTINCT FROM OLD.result_hash
         OR NEW.settlement_version IS DISTINCT FROM OLD.settlement_version
         OR NEW.total_payout_base_units IS DISTINCT FROM OLD.total_payout_base_units
         OR NEW.fee_base_units IS DISTINCT FROM OLD.fee_base_units THEN
        RAISE EXCEPTION 'approved settlement economic fields are immutable'
          USING ERRCODE = '55000';
      END IF;
      IF OLD.merkle_root IS NOT NULL AND NEW.merkle_root IS DISTINCT FROM OLD.merkle_root THEN
        RAISE EXCEPTION 'merkle_root is immutable once set'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS contest_settlements_approved_guard ON contest_settlements;
CREATE TRIGGER contest_settlements_approved_guard
  BEFORE UPDATE ON contest_settlements
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_approved_settlement_header_mutation();
