-- Phase 4 deposit reconciliation. Additive. Does not edit 001-003.
-- Amounts stay integer base units. This migration does not move USDC.
-- There is no withdrawal, settlement, or treasury transfer table.

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
  'SCORE_RECOMPUTED',
  'REVIEW_APPROVED',
  'REVIEW_REJECTED',
  'SETTLEMENT_SUBMITTED',
  'PAYOUT_CLAIMED',
  'CONTEST_REFUNDED'
));

ALTER TABLE contests
  ADD COLUMN confirmed_count integer NOT NULL DEFAULT 0,
  ADD COLUMN escrow_pda text NULL,
  ADD COLUMN vault_address text NULL,
  ADD COLUMN usdc_mint text NULL,
  ADD CONSTRAINT contests_confirmed_nonnegative CHECK (confirmed_count >= 0),
  ADD CONSTRAINT contests_confirmed_within_capacity CHECK (confirmed_count <= capacity);

COMMENT ON COLUMN contests.confirmed_count IS
  'Deposits the indexer verified at finalized commitment. Not filled_count. A reservation is not a confirmation.';

ALTER TABLE contest_reservations
  ADD COLUMN nonce_hash text NOT NULL DEFAULT '',
  ADD COLUMN deposit_signature text NULL,
  ADD COLUMN submitted_at timestamptz NULL,
  ADD COLUMN confirmation_status text NOT NULL DEFAULT 'NONE',
  ADD CONSTRAINT contest_reservations_confirmation_known CHECK (
    confirmation_status IN ('NONE', 'SUBMITTED', 'VERIFIED', 'REJECTED')
  );

CREATE UNIQUE INDEX contest_reservations_nonce_hash_uidx
  ON contest_reservations (nonce_hash)
  WHERE nonce_hash <> '';

COMMENT ON COLUMN contest_reservations.deposit_signature IS
  'A submitted signature is not a seat. ENTRY_CONFIRMED waits for a finalized match.';

ALTER TABLE contest_entries
  ADD COLUMN confirmation_status text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN deposit_signature text NULL,
  ADD COLUMN confirmed_slot bigint NULL,
  ADD COLUMN confirmed_block_time timestamptz NULL,
  ADD COLUMN chain_amount_base_units bigint NULL,
  ADD COLUMN mint text NULL,
  ADD COLUMN vault_address text NULL,
  ADD COLUMN deposit_receipt text NULL,
  ADD CONSTRAINT contest_entries_confirmation_known CHECK (
    confirmation_status IN ('PENDING', 'CONFIRMED', 'REJECTED')
  ),
  ADD CONSTRAINT contest_entries_chain_amount_nonnegative CHECK (
    chain_amount_base_units IS NULL OR chain_amount_base_units >= 0
  );

COMMENT ON COLUMN contest_entries.team_version_id IS
  'Immutable team version captured at reservation. Chain confirmation must not switch it.';

CREATE TABLE deposit_reconciliations (
  id uuid PRIMARY KEY,
  signature text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  reservation_id uuid NULL REFERENCES contest_reservations (id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT deposit_reconciliations_status_known CHECK (status IN ('REJECTED')),
  CONSTRAINT deposit_reconciliations_signature_unique UNIQUE (signature)
);

CREATE INDEX deposit_reconciliations_reason_idx ON deposit_reconciliations (reason);

COMMENT ON TABLE deposit_reconciliations IS
  'Mismatched or unknown deposits. Logging a row does not move USDC and does not attach an unknown deposit to another user. No manual transfer is represented here.';
