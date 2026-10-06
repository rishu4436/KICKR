-- Phase 8 reliability. Additive and backward-safe for the current Devnet database.
-- New constraints that could reject legacy rows are NOT VALID or created only when no duplicates exist.
-- Audit remains append-only. RUN_SETTLEMENT is not granted. No custody columns.

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer NOT NULL,
  response_body jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, idempotency_key),
  CONSTRAINT idempotency_records_key_len CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
  CONSTRAINT idempotency_records_hash_len CHECK (char_length(request_hash) = 64),
  CONSTRAINT idempotency_records_status_known CHECK (response_status >= 0 AND response_status <= 599),
  CONSTRAINT idempotency_records_body_json CHECK (jsonb_typeof(response_body) IN ('object', 'array'))
);

COMMENT ON TABLE idempotency_records IS
  'Caller-supplied idempotency keys for financial and access mutations. Not a timestamp. Replay returns the stored response. Conflicting reuse fails the unique key.';

ALTER TABLE settlement_result_rows
  DROP CONSTRAINT IF EXISTS settlement_result_rows_claimed_has_time;
ALTER TABLE settlement_result_rows
  ADD CONSTRAINT settlement_result_rows_claimed_has_time
  CHECK (claim_status <> 'CLAIMED' OR claimed_at IS NOT NULL) NOT VALID;

ALTER TABLE contest_entries
  DROP CONSTRAINT IF EXISTS contest_entries_confirmed_has_signature;
ALTER TABLE contest_entries
  ADD CONSTRAINT contest_entries_confirmed_has_signature
  CHECK (status <> 'CONFIRMED' OR deposit_signature IS NOT NULL) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contest_entries
    WHERE status IN ('PENDING', 'CONFIRMED')
    GROUP BY contest_id, wallet
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS contest_entries_active_wallet_uidx
      ON contest_entries (contest_id, wallet)
      WHERE status IN ('PENDING', 'CONFIRMED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM contest_entries
    WHERE deposit_signature IS NOT NULL AND status = 'CONFIRMED'
    GROUP BY deposit_signature
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS contest_entries_confirmed_signature_uidx
      ON contest_entries (deposit_signature)
      WHERE deposit_signature IS NOT NULL AND status = 'CONFIRMED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM settlement_result_rows
    WHERE claim_signature IS NOT NULL AND claim_status = 'CLAIMED'
    GROUP BY claim_signature
    HAVING count(*) > 1
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS settlement_result_rows_claimed_signature_uidx
      ON settlement_result_rows (claim_signature)
      WHERE claim_signature IS NOT NULL AND claim_status = 'CLAIMED';
  END IF;
END $$;
