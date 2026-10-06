-- Phase 13: private FREE leagues + lightweight profiles.
-- Additive and backward-safe. No USDC, escrow, settlement, or prize columns.
-- Does not touch fee policy 1000 bps, RUN_SETTLEMENT, or attestation.

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS display_name text NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_display_name_len'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_display_name_len
      CHECK (display_name IS NULL OR (char_length(display_name) BETWEEN 1 AND 32));
  END IF;
END $$;

COMMENT ON COLUMN accounts.display_name IS
  'Optional sanitized public display name. Never a wallet or monetary claim.';

CREATE TABLE IF NOT EXISTS private_leagues (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  match_id uuid NOT NULL REFERENCES matches (id),
  owner_account_id uuid NOT NULL REFERENCES accounts (id),
  owner_wallet text NOT NULL,
  invite_code text NOT NULL,
  capacity integer NOT NULL,
  member_count integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPEN',
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT private_leagues_name_len CHECK (char_length(name) BETWEEN 3 AND 48),
  CONSTRAINT private_leagues_invite_len CHECK (char_length(invite_code) BETWEEN 6 AND 16),
  CONSTRAINT private_leagues_capacity_range CHECK (capacity >= 2 AND capacity <= 50),
  CONSTRAINT private_leagues_member_lte_capacity CHECK (member_count >= 0 AND member_count <= capacity),
  CONSTRAINT private_leagues_owner_wallet_len CHECK (char_length(owner_wallet) BETWEEN 32 AND 44),
  CONSTRAINT private_leagues_status_known CHECK (status IN ('OPEN', 'FULL', 'LOCKED', 'COMPLETED'))
);

CREATE UNIQUE INDEX IF NOT EXISTS private_leagues_invite_code_uidx ON private_leagues (invite_code);
CREATE INDEX IF NOT EXISTS private_leagues_match_idx ON private_leagues (match_id);
CREATE INDEX IF NOT EXISTS private_leagues_owner_idx ON private_leagues (owner_account_id);

COMMENT ON TABLE private_leagues IS
  'Invite-based FREE private leagues. No USDC, prize, escrow, or settlement.';

CREATE TABLE IF NOT EXISTS private_league_members (
  id uuid PRIMARY KEY,
  league_id uuid NOT NULL REFERENCES private_leagues (id),
  account_id uuid NOT NULL REFERENCES accounts (id),
  wallet text NOT NULL,
  team_version_id uuid NOT NULL REFERENCES fantasy_team_versions (id),
  joined_at timestamptz NOT NULL,
  CONSTRAINT private_league_members_wallet_len CHECK (char_length(wallet) BETWEEN 32 AND 44)
);

CREATE UNIQUE INDEX IF NOT EXISTS private_league_members_league_wallet_uidx
  ON private_league_members (league_id, wallet);
CREATE UNIQUE INDEX IF NOT EXISTS private_league_members_league_account_uidx
  ON private_league_members (league_id, account_id);
CREATE INDEX IF NOT EXISTS private_league_members_wallet_idx ON private_league_members (wallet);

COMMENT ON TABLE private_league_members IS
  'Private league seats. Confirmed on join. No deposit signature.';

CREATE TABLE IF NOT EXISTS private_league_results (
  id uuid PRIMARY KEY,
  league_id uuid NOT NULL UNIQUE REFERENCES private_leagues (id),
  match_id uuid NOT NULL REFERENCES matches (id),
  status text NOT NULL,
  rows jsonb NOT NULL,
  finalized_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT private_league_results_status_final CHECK (status = 'FINAL'),
  CONSTRAINT private_league_results_rows_array CHECK (jsonb_typeof(rows) = 'array')
);

COMMENT ON TABLE private_league_results IS
  'FREE private league final score+rank snapshots. No Merkle root, no payouts.';

CREATE INDEX IF NOT EXISTS private_league_results_match_idx ON private_league_results (match_id);

-- Extend audit action allow-list for social / profile events.
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
  'PROFILE_UPDATED'
));
