-- Phase 3 contest engine. Additive. Does not edit 001 or 002.
-- USDC amounts are bigint base units (6 decimals). 5 USDC = 5000000.
-- No escrow account, no payout execution, no settlement transfer.
-- CONFIRMED on reservations and entries is reserved for Phase 4.
-- This migration does not insert a confirmed row and does not move USDC.

ALTER TABLE audit_events DROP CONSTRAINT audit_events_action_known;
ALTER TABLE audit_events ADD CONSTRAINT audit_events_action_known CHECK (action IN (
  'ACCOUNT_LOGIN',
  'ACCOUNT_LOGOUT',
  'TEAM_SAVED',
  'CONTEST_CREATED',
  'CONTEST_FILLED',
  'JOIN_QUOTED',
  'ENTRY_RESERVED',
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

CREATE TABLE payout_policies (
  id uuid NOT NULL,
  version integer NOT NULL,
  policy_type text NOT NULL,
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (id, version),
  CONSTRAINT payout_policies_version_positive CHECK (version >= 1),
  CONSTRAINT payout_policies_type_known CHECK (policy_type IN ('HEAD_TO_HEAD', 'WINNER_TAKES_ALL', 'GRAND_LEAGUE')),
  CONSTRAINT payout_policies_configuration_object CHECK (jsonb_typeof(configuration) = 'object')
);

COMMENT ON TABLE payout_policies IS
  'Versioned payout shape only. Phase 3 does not calculate or transfer winnings.';

CREATE TABLE fee_policies (
  id uuid NOT NULL,
  version integer NOT NULL,
  rate_bps integer NOT NULL,
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (id, version),
  CONSTRAINT fee_policies_version_positive CHECK (version >= 1),
  CONSTRAINT fee_policies_rate_nonnegative CHECK (rate_bps >= 0),
  CONSTRAINT fee_policies_configuration_object CHECK (jsonb_typeof(configuration) = 'object')
);

COMMENT ON TABLE fee_policies IS
  'Integer basis points. The seeded 1000 bps row is DEV only. TODO: production bps are unspecified.';

CREATE TABLE contest_templates (
  id uuid PRIMARY KEY,
  template_code text NOT NULL,
  contest_type text NOT NULL,
  entry_fee_base_units bigint NOT NULL,
  capacity integer NOT NULL,
  payout_policy_id uuid NOT NULL,
  payout_policy_version integer NOT NULL,
  fee_policy_id uuid NOT NULL,
  fee_policy_version integer NOT NULL,
  currency text NOT NULL,
  enabled boolean NOT NULL,
  version integer NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT contest_templates_code_unique UNIQUE (template_code),
  CONSTRAINT contest_templates_type_known CHECK (contest_type IN ('HEAD_TO_HEAD', 'WINNER_TAKES_ALL', 'GRAND_LEAGUE')),
  CONSTRAINT contest_templates_fee_nonnegative CHECK (entry_fee_base_units >= 0),
  CONSTRAINT contest_templates_capacity_positive CHECK (capacity > 0),
  CONSTRAINT contest_templates_currency_usdc CHECK (currency = 'USDC'),
  CONSTRAINT contest_templates_version_positive CHECK (version >= 1),
  CONSTRAINT contest_templates_payout_fk FOREIGN KEY (payout_policy_id, payout_policy_version)
    REFERENCES payout_policies (id, version),
  CONSTRAINT contest_templates_fee_fk FOREIGN KEY (fee_policy_id, fee_policy_version)
    REFERENCES fee_policies (id, version)
);

COMMENT ON TABLE contest_templates IS
  'Templates are not instances. Development seed is not a production fee freeze. More tiers can be inserted later.';

CREATE TABLE contests (
  id uuid PRIMARY KEY,
  template_id uuid NOT NULL REFERENCES contest_templates (id),
  match_id uuid NOT NULL REFERENCES matches (id),
  contest_type text NOT NULL,
  status text NOT NULL,
  capacity integer NOT NULL,
  filled_count integer NOT NULL,
  entry_fee_base_units bigint NOT NULL,
  currency text NOT NULL,
  rules_snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  locked_at timestamptz NULL,
  completed_at timestamptz NULL,
  CONSTRAINT contests_type_known CHECK (contest_type IN ('HEAD_TO_HEAD', 'WINNER_TAKES_ALL', 'GRAND_LEAGUE')),
  CONSTRAINT contests_status_known CHECK (status IN (
    'OPEN', 'PARTIALLY_FILLED', 'FULL', 'PENDING', 'CONFIRMED', 'LOCKED',
    'IN_PROGRESS', 'IN_REVIEW', 'READY_FOR_SETTLEMENT', 'SETTLED', 'REFUNDED', 'VOID'
  )),
  CONSTRAINT contests_capacity_positive CHECK (capacity > 0),
  CONSTRAINT contests_filled_nonnegative CHECK (filled_count >= 0),
  CONSTRAINT contests_filled_within_capacity CHECK (filled_count <= capacity),
  CONSTRAINT contests_fee_nonnegative CHECK (entry_fee_base_units >= 0),
  CONSTRAINT contests_currency_usdc CHECK (currency = 'USDC'),
  CONSTRAINT contests_snapshot_object CHECK (jsonb_typeof(rules_snapshot) = 'object')
);

CREATE INDEX contests_match_status_idx ON contests (match_id, status);
CREATE INDEX contests_template_match_status_idx ON contests (template_id, match_id, status);

-- One discoverable H2H room per match and template. Database uniqueness, not an app check.
CREATE UNIQUE INDEX contests_h2h_one_joinable_uidx
  ON contests (match_id, template_id)
  WHERE status IN ('OPEN', 'PARTIALLY_FILLED') AND contest_type = 'HEAD_TO_HEAD';

-- Grand League and Winner-Takes-All are one instance per match and template. Not a rotating room.
CREATE UNIQUE INDEX contests_single_instance_uidx
  ON contests (match_id, template_id)
  WHERE contest_type IN ('GRAND_LEAGUE', 'WINNER_TAKES_ALL');

COMMENT ON TABLE contests IS
  'Contest instance. rules_snapshot is immutable. filled_count is authoritative. Redis counts are not.';

CREATE OR REPLACE FUNCTION kickr_reject_contest_snapshot_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.rules_snapshot IS DISTINCT FROM OLD.rules_snapshot THEN
    RAISE EXCEPTION 'contest rules_snapshot is immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER contests_snapshot_frozen
  BEFORE UPDATE ON contests
  FOR EACH ROW
  EXECUTE FUNCTION kickr_reject_contest_snapshot_update();

CREATE TABLE contest_reservations (
  id uuid PRIMARY KEY,
  contest_id uuid NOT NULL REFERENCES contests (id),
  wallet text NOT NULL,
  team_version_id uuid NOT NULL REFERENCES fantasy_team_versions (id),
  amount_base_units bigint NOT NULL,
  currency text NOT NULL,
  nonce text NOT NULL,
  escrow_placeholder jsonb NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT contest_reservations_amount_nonnegative CHECK (amount_base_units >= 0),
  CONSTRAINT contest_reservations_currency_usdc CHECK (currency = 'USDC'),
  CONSTRAINT contest_reservations_nonce_len CHECK (char_length(nonce) BETWEEN 16 AND 128),
  CONSTRAINT contest_reservations_placeholder_object CHECK (jsonb_typeof(escrow_placeholder) = 'object'),
  CONSTRAINT contest_reservations_status_known CHECK (status IN ('PENDING', 'EXPIRED', 'CANCELLED', 'CONFIRMED'))
);

CREATE UNIQUE INDEX contest_reservations_nonce_uidx ON contest_reservations (nonce);
CREATE INDEX contest_reservations_status_expiry_idx ON contest_reservations (status, expires_at);
CREATE UNIQUE INDEX contest_reservations_active_team_uidx
  ON contest_reservations (contest_id, team_version_id)
  WHERE status IN ('PENDING', 'CONFIRMED');

COMMENT ON TABLE contest_reservations IS
  'Join quote. CONFIRMED exists for Phase 4 and is not set by the Phase 3 join path. escrow_placeholder is not an escrow address. No USDC moves.';

CREATE TABLE contest_entries (
  id uuid PRIMARY KEY,
  contest_id uuid NOT NULL REFERENCES contests (id),
  wallet text NOT NULL,
  team_version_id uuid NOT NULL REFERENCES fantasy_team_versions (id),
  reservation_id uuid NOT NULL UNIQUE REFERENCES contest_reservations (id),
  status text NOT NULL,
  seat_number integer NOT NULL,
  joined_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT contest_entries_status_known CHECK (status IN ('PENDING', 'CONFIRMED', 'REFUNDED', 'CANCELLED')),
  CONSTRAINT contest_entries_seat_positive CHECK (seat_number > 0)
);

CREATE UNIQUE INDEX contest_entries_seat_uidx ON contest_entries (contest_id, seat_number);
CREATE UNIQUE INDEX contest_entries_active_wallet_uidx
  ON contest_entries (contest_id, wallet)
  WHERE status IN ('PENDING', 'CONFIRMED');
CREATE INDEX contest_entries_contest_wallet_idx ON contest_entries (contest_id, wallet);

COMMENT ON TABLE contest_entries IS
  'Seat rows. Phase 3 inserts PENDING only. team_version_id is the version at reserve time, not a latest pointer. joined_at on a PENDING row is the quote time, not a paid join. CONFIRMED is for Phase 4.';

CREATE TABLE contest_outbox (
  id uuid PRIMARY KEY,
  event_type text NOT NULL,
  contest_id uuid NOT NULL REFERENCES contests (id),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  published_at timestamptz NULL,
  CONSTRAINT contest_outbox_type_known CHECK (event_type IN ('CONTEST_FILLED')),
  CONSTRAINT contest_outbox_payload_object CHECK (jsonb_typeof(payload) = 'object')
);

CREATE INDEX contest_outbox_unpublished_idx ON contest_outbox (created_at) WHERE published_at IS NULL;

COMMENT ON TABLE contest_outbox IS
  'Durable contest domain events. Redis pub/sub is not the only trigger. Phase 3 writes CONTEST_FILLED when an H2H room reaches capacity.';

-- Development seed. Not a production fee freeze.
INSERT INTO fee_policies (id, version, rate_bps, configuration, created_at) VALUES
  (
    '51000000-0000-4000-8000-000000000001',
    1,
    1000,
    '{"label":"DEV","note":"TODO: production fee bps are unspecified. 1000 is development config only and is not platform revenue."}'::jsonb,
    '2026-01-01T00:00:00.000Z'
  );

INSERT INTO payout_policies (id, version, policy_type, configuration, created_at) VALUES
  ('52000000-0000-4000-8000-000000000001', 1, 'HEAD_TO_HEAD', '{"shape":"HEAD_TO_HEAD","calculation":"none"}'::jsonb, '2026-01-01T00:00:00.000Z'),
  ('52000000-0000-4000-8000-000000000002', 1, 'WINNER_TAKES_ALL', '{"shape":"WINNER_TAKES_ALL","calculation":"none"}'::jsonb, '2026-01-01T00:00:00.000Z'),
  ('52000000-0000-4000-8000-000000000003', 1, 'GRAND_LEAGUE', '{"shape":"GRAND_LEAGUE","calculation":"none"}'::jsonb, '2026-01-01T00:00:00.000Z');

INSERT INTO contest_templates (
  id, template_code, contest_type, entry_fee_base_units, capacity,
  payout_policy_id, payout_policy_version, fee_policy_id, fee_policy_version,
  currency, enabled, version, created_at, updated_at
) VALUES
  ('53000000-0000-4000-8000-000000000001', 'H2H-5', 'HEAD_TO_HEAD', 5000000, 2, '52000000-0000-4000-8000-000000000001', 1, '51000000-0000-4000-8000-000000000001', 1, 'USDC', true, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('53000000-0000-4000-8000-000000000002', 'H2H-10', 'HEAD_TO_HEAD', 10000000, 2, '52000000-0000-4000-8000-000000000001', 1, '51000000-0000-4000-8000-000000000001', 1, 'USDC', true, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('53000000-0000-4000-8000-000000000003', 'H2H-20', 'HEAD_TO_HEAD', 20000000, 2, '52000000-0000-4000-8000-000000000001', 1, '51000000-0000-4000-8000-000000000001', 1, 'USDC', true, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('53000000-0000-4000-8000-000000000004', 'H2H-50', 'HEAD_TO_HEAD', 50000000, 2, '52000000-0000-4000-8000-000000000001', 1, '51000000-0000-4000-8000-000000000001', 1, 'USDC', true, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('53000000-0000-4000-8000-000000000005', 'GRAND-5', 'GRAND_LEAGUE', 5000000, 1000, '52000000-0000-4000-8000-000000000003', 1, '51000000-0000-4000-8000-000000000001', 1, 'USDC', true, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
  ('53000000-0000-4000-8000-000000000006', 'WTA-20', 'WINNER_TAKES_ALL', 20000000, 10, '52000000-0000-4000-8000-000000000002', 1, '51000000-0000-4000-8000-000000000001', 1, 'USDC', true, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
