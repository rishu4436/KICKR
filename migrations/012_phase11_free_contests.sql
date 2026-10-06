-- Phase 11 FREE-to-play contests. Additive and backward-safe.
-- Existing rows default to PAID_DEVNET. FREE must have fee 0 and prize pool 0.
-- Does not touch escrow program, fee policy 1000 bps, or RUN_SETTLEMENT grants.

ALTER TABLE contest_templates
  ADD COLUMN IF NOT EXISTS contest_kind text NOT NULL DEFAULT 'PAID_DEVNET';

ALTER TABLE contest_templates
  ADD COLUMN IF NOT EXISTS prize_pool_base_units bigint NOT NULL DEFAULT 0;

ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS contest_kind text NOT NULL DEFAULT 'PAID_DEVNET';

ALTER TABLE contests
  ADD COLUMN IF NOT EXISTS prize_pool_base_units bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contest_templates_kind_known'
  ) THEN
    ALTER TABLE contest_templates
      ADD CONSTRAINT contest_templates_kind_known
      CHECK (contest_kind IN ('FREE', 'PAID_DEVNET'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contest_templates_prize_nonnegative'
  ) THEN
    ALTER TABLE contest_templates
      ADD CONSTRAINT contest_templates_prize_nonnegative
      CHECK (prize_pool_base_units >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contest_templates_free_economics'
  ) THEN
    ALTER TABLE contest_templates
      ADD CONSTRAINT contest_templates_free_economics
      CHECK (
        contest_kind <> 'FREE'
        OR (entry_fee_base_units = 0 AND prize_pool_base_units = 0)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contests_kind_known'
  ) THEN
    ALTER TABLE contests
      ADD CONSTRAINT contests_kind_known
      CHECK (contest_kind IN ('FREE', 'PAID_DEVNET'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contests_prize_nonnegative'
  ) THEN
    ALTER TABLE contests
      ADD CONSTRAINT contests_prize_nonnegative
      CHECK (prize_pool_base_units >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'contests_free_economics'
  ) THEN
    ALTER TABLE contests
      ADD CONSTRAINT contests_free_economics
      CHECK (
        contest_kind <> 'FREE'
        OR (entry_fee_base_units = 0 AND prize_pool_base_units = 0)
      );
  END IF;
END $$;

COMMENT ON COLUMN contest_templates.contest_kind IS
  'FREE = product free-to-play. PAID_DEVNET = existing escrow path. Production must not enable paid entry.';
COMMENT ON COLUMN contests.contest_kind IS
  'Frozen contest kind. FREE never uses deposit, escrow, settlement roots, or claim.';

-- FREE fee policy (0 bps). DEV paid fee policy 1000 bps is unchanged.
INSERT INTO fee_policies (id, version, rate_bps, configuration, created_at) VALUES
  (
    '51000000-0000-4000-8000-0000000000f1',
    1,
    0,
    '{"label":"FREE","note":"FREE contests have no fee and no monetary prize."}'::jsonb,
    '2026-10-06T00:00:00.000Z'
  )
ON CONFLICT (id, version) DO NOTHING;

INSERT INTO payout_policies (id, version, policy_type, configuration, created_at) VALUES
  (
    '52000000-0000-4000-8000-0000000000f1',
    1,
    'HEAD_TO_HEAD',
    '{"shape":"HEAD_TO_HEAD","calculation":"none","monetary":false,"tiePolicy":"entry_id_asc","note":"FREE H2H. Rank and score only."}'::jsonb,
    '2026-10-06T00:00:00.000Z'
  ),
  (
    '52000000-0000-4000-8000-0000000000f3',
    1,
    'GRAND_LEAGUE',
    '{"shape":"GRAND_LEAGUE","calculation":"none","monetary":false,"tiePolicy":"entry_id_asc","note":"FREE Grand League. Rank and score only."}'::jsonb,
    '2026-10-06T00:00:00.000Z'
  )
ON CONFLICT (id, version) DO NOTHING;

INSERT INTO contest_templates (
  id, template_code, contest_type, contest_kind, entry_fee_base_units, prize_pool_base_units, capacity,
  payout_policy_id, payout_policy_version, fee_policy_id, fee_policy_version,
  currency, enabled, version, created_at, updated_at
) VALUES
  (
    '53000000-0000-4000-8000-0000000000f1', 'FREE-H2H', 'HEAD_TO_HEAD', 'FREE', 0, 0, 2,
    '52000000-0000-4000-8000-0000000000f1', 1,
    '51000000-0000-4000-8000-0000000000f1', 1,
    'USDC', true, 1, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z'
  ),
  (
    '53000000-0000-4000-8000-0000000000f5', 'FREE-GRAND', 'GRAND_LEAGUE', 'FREE', 0, 0, 1000,
    '52000000-0000-4000-8000-0000000000f3', 1,
    '51000000-0000-4000-8000-0000000000f1', 1,
    'USDC', true, 1, '2026-10-06T00:00:00.000Z', '2026-10-06T00:00:00.000Z'
  )
ON CONFLICT (id) DO NOTHING;

-- Mark existing templates as PAID_DEVNET explicitly (default already).
UPDATE contest_templates SET contest_kind = 'PAID_DEVNET' WHERE contest_kind IS NULL OR contest_kind = 'PAID_DEVNET';
UPDATE contests SET contest_kind = 'PAID_DEVNET' WHERE contest_kind IS NULL OR contest_kind = 'PAID_DEVNET';

CREATE TABLE IF NOT EXISTS free_contest_results (
  id uuid PRIMARY KEY,
  contest_id uuid NOT NULL UNIQUE REFERENCES contests (id),
  match_id uuid NOT NULL REFERENCES matches (id),
  status text NOT NULL,
  rows jsonb NOT NULL,
  finalized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT free_contest_results_status_final CHECK (status = 'FINAL'),
  CONSTRAINT free_contest_results_rows_array CHECK (jsonb_typeof(rows) = 'array')
);

COMMENT ON TABLE free_contest_results IS
  'FREE contest final score+rank snapshots. No Merkle root, no payouts, no claim.';

CREATE INDEX IF NOT EXISTS free_contest_results_match_idx ON free_contest_results (match_id);


-- FREE confirmed entries have no on-chain deposit signature.
-- Keep paid CONFIRMED rows requiring a signature; allow fee-0 confirmed seats without one.
ALTER TABLE contest_entries DROP CONSTRAINT IF EXISTS contest_entries_confirmed_has_signature;
ALTER TABLE contest_entries
  ADD CONSTRAINT contest_entries_confirmed_has_signature
  CHECK (
    status <> 'CONFIRMED'
    OR deposit_signature IS NOT NULL
    OR COALESCE(chain_amount_base_units, 0) = 0
  );

