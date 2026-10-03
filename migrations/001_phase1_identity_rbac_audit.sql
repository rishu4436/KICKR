-- Phase 1 authoritative identity, RBAC, and audit schema.
-- The Solana escrow program does NOT exist in Phase 1.
-- No USDC columns are created. If a future migration adds USDC values,
-- they must be bigint integer base units, never floating point, and unused
-- until a later phase.
-- There is no private key, seed phrase, or escrow signer column.

CREATE TABLE accounts (
  id uuid PRIMARY KEY,
  wallet_address text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz NULL,
  CONSTRAINT accounts_wallet_len CHECK (char_length(wallet_address) BETWEEN 32 AND 44),
  CONSTRAINT accounts_deleted_after_create CHECK (deleted_at IS NULL OR deleted_at >= created_at)
);

CREATE UNIQUE INDEX accounts_wallet_address_uidx ON accounts (wallet_address);
CREATE INDEX accounts_deleted_at_idx ON accounts (deleted_at);

COMMENT ON TABLE accounts IS
  'One Solana wallet maps to one account. No password. Soft-delete via deleted_at. Wallet uniqueness includes deleted rows so the same wallet cannot open a second account. TODO: restore flow is unspecified.';

CREATE TABLE login_nonces (
  id uuid PRIMARY KEY,
  nonce text NOT NULL,
  wallet_address text NOT NULL,
  domain text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT login_nonces_nonce_len CHECK (char_length(nonce) BETWEEN 16 AND 128),
  CONSTRAINT login_nonces_domain_len CHECK (char_length(domain) BETWEEN 1 AND 255),
  CONSTRAINT login_nonces_consume_after_create CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE UNIQUE INDEX login_nonces_nonce_uidx ON login_nonces (nonce);
CREATE INDEX login_nonces_wallet_created_idx ON login_nonces (wallet_address, created_at DESC);

COMMENT ON TABLE login_nonces IS
  'Single-use login nonces. The application does not delete rows, so a consumed nonce cannot be replayed. TODO: retention and purge policy is unspecified.';

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id),
  token_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  CONSTRAINT sessions_token_hash_len CHECK (char_length(token_hash) = 64),
  CONSTRAINT sessions_expiry_after_create CHECK (expires_at > created_at),
  CONSTRAINT sessions_revoke_after_create CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE UNIQUE INDEX sessions_token_hash_uidx ON sessions (token_hash);
CREATE INDEX sessions_account_id_idx ON sessions (account_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

COMMENT ON TABLE sessions IS
  'Bearer sessions. Only the SHA-256 hex of the token is stored. Deletion policy: set revoked_at. Phase 1 does not hard-delete sessions. TODO: retention is unspecified. TODO: concurrent session policy is unspecified.';

CREATE TABLE roles (
  code text PRIMARY KEY,
  description text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT roles_code_known CHECK (code IN (
    'CEO_HEAD',
    'APP_DEVELOPER',
    'BACKEND_DEVELOPER',
    'TESTER',
    'PRODUCT_MANAGER',
    'UI_UX_DEVELOPER',
    'SUPPORT'
  ))
);

COMMENT ON TABLE roles IS
  'Reference data. No HTTP delete. Planned headcount is not enforced. TODO: headcount enforcement is unspecified.';

CREATE TABLE permissions (
  code text PRIMARY KEY,
  permission_group text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT permissions_group_known CHECK (permission_group IN ('READ', 'OPERATE', 'APPROVE', 'ADMINISTER')),
  CONSTRAINT permissions_code_known CHECK (code IN (
    'READ_SYSTEM',
    'READ_CONTEST',
    'READ_USER_HISTORY',
    'WRITE_SUPPORT_NOTE',
    'READ_AUDIT',
    'MANAGE_MATCH_CONFIG',
    'MANAGE_CONTEST_CONFIG',
    'REVIEW_RESULT',
    'RUN_SCORING',
    'RUN_SETTLEMENT',
    'MANAGE_RBAC',
    'MANAGE_SYSTEM'
  )),
  CONSTRAINT permissions_no_escrow CHECK (code NOT IN ('MOVE_ESCROW', 'MOVE_FUNDS', 'PAYOUT'))
);

COMMENT ON TABLE permissions IS
  'Explicit permission catalog. There is no MOVE_ESCROW permission. INDEXER_CONFIRM_ENTRY is intentionally absent so it cannot be granted to a human role. No HTTP delete.';

CREATE TABLE account_roles (
  account_id uuid NOT NULL REFERENCES accounts (id),
  role_code text NOT NULL REFERENCES roles (code),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  granted_by_account_id uuid NULL REFERENCES accounts (id),
  PRIMARY KEY (account_id, role_code)
);

CREATE INDEX account_roles_role_code_idx ON account_roles (role_code);

COMMENT ON TABLE account_roles IS
  'Role assignment. Phase 1 exposes no HTTP writer. Unassign would delete a row in a future audited flow. TODO: no audit event type was specified for RBAC changes.';

CREATE TABLE account_capability_grants (
  account_id uuid NOT NULL REFERENCES accounts (id),
  capability text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  granted_by_account_id uuid NULL REFERENCES accounts (id),
  PRIMARY KEY (account_id, capability),
  CONSTRAINT account_capability_known CHECK (capability IN ('REVIEWER'))
);

CREATE INDEX account_capability_grants_account_idx ON account_capability_grants (account_id);

COMMENT ON TABLE account_capability_grants IS
  'REVIEWER is a capability, not a role. The application map grants REVIEW_RESULT only.';

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_account_id uuid NULL REFERENCES accounts (id),
  actor_wallet text NULL,
  action text NOT NULL,
  occurred_at timestamptz NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  metadata jsonb NOT NULL,
  correlation_id text NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT audit_events_action_known CHECK (action IN (
    'ACCOUNT_LOGIN',
    'ACCOUNT_LOGOUT',
    'TEAM_SAVED',
    'JOIN_QUOTED',
    'ENTRY_CONFIRMED',
    'ENTRY_REFUNDED',
    'CONTEST_LOCKED',
    'SCORE_RECOMPUTED',
    'REVIEW_APPROVED',
    'REVIEW_REJECTED',
    'SETTLEMENT_SUBMITTED',
    'PAYOUT_CLAIMED',
    'CONTEST_REFUNDED'
  )),
  CONSTRAINT audit_events_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT audit_events_entity_type_len CHECK (char_length(entity_type) BETWEEN 1 AND 64),
  CONSTRAINT audit_events_entity_id_len CHECK (char_length(entity_id) BETWEEN 1 AND 128)
);

CREATE INDEX audit_events_occurred_at_idx ON audit_events (occurred_at, id);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id);
CREATE INDEX audit_events_actor_idx ON audit_events (actor_account_id);
CREATE INDEX audit_events_action_idx ON audit_events (action);
CREATE INDEX audit_events_correlation_idx ON audit_events (correlation_id);

COMMENT ON TABLE audit_events IS
  'Append-only. No updated_at column. UPDATE and DELETE are rejected by trigger and revoked from PUBLIC.';

CREATE OR REPLACE FUNCTION kickr_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER accounts_set_updated_at
  BEFORE UPDATE ON accounts
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER sessions_set_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER roles_set_updated_at
  BEFORE UPDATE ON roles
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER permissions_set_updated_at
  BEFORE UPDATE ON permissions
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER account_roles_set_updated_at
  BEFORE UPDATE ON account_roles
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER account_capability_grants_set_updated_at
  BEFORE UPDATE ON account_capability_grants
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE TRIGGER login_nonces_set_updated_at
  BEFORE UPDATE ON login_nonces
  FOR EACH ROW EXECUTE FUNCTION kickr_set_updated_at();

CREATE OR REPLACE FUNCTION kickr_forbid_audit_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only; % is forbidden', TG_OP
    USING ERRCODE = '55000';
END;
$$;

CREATE TRIGGER audit_events_no_update
  BEFORE UPDATE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_audit_mutation();

CREATE TRIGGER audit_events_no_delete
  BEFORE DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION kickr_forbid_audit_mutation();

REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;

INSERT INTO roles (code, description, created_at, updated_at) VALUES
  ('CEO_HEAD', 'Head of company. RBAC and system administration. Not settlement execution and not escrow.', now(), now()),
  ('APP_DEVELOPER', 'Application developer. Read-only system and contest visibility.', now(), now()),
  ('BACKEND_DEVELOPER', 'Backend developer. Match and contest configuration and scoring runs. Not review, settlement, or escrow.', now(), now()),
  ('TESTER', 'Tester. Read-only system and contest visibility.', now(), now()),
  ('PRODUCT_MANAGER', 'Product manager. Contest and match configuration. Not settlement and not scores.', now(), now()),
  ('UI_UX_DEVELOPER', 'UI/UX developer. Read system only.', now(), now()),
  ('SUPPORT', 'Support. User history, support notes, and contest reads. Cannot administer, modify audit, scores, winners, or money.', now(), now());

INSERT INTO permissions (code, permission_group, description, created_at, updated_at) VALUES
  ('READ_SYSTEM', 'READ', 'Read non-sensitive system status.', now(), now()),
  ('READ_CONTEST', 'READ', 'Read contest records.', now(), now()),
  ('READ_USER_HISTORY', 'READ', 'Read a user history view. Does not include money mutation.', now(), now()),
  ('WRITE_SUPPORT_NOTE', 'OPERATE', 'Write a support note. Storage schema is TODO. Does not modify scores, winners, audit, or money.', now(), now()),
  ('READ_AUDIT', 'READ', 'Read the append-only audit log. Does not permit update or delete.', now(), now()),
  ('MANAGE_MATCH_CONFIG', 'OPERATE', 'Manage match configuration. Does not score or settle.', now(), now()),
  ('MANAGE_CONTEST_CONFIG', 'OPERATE', 'Manage contest configuration. Does not settle or move funds.', now(), now()),
  ('REVIEW_RESULT', 'APPROVE', 'Review a result. Granted only through the REVIEWER capability, not through a normal role.', now(), now()),
  ('RUN_SCORING', 'OPERATE', 'Run scoring. Must not touch escrow. Does not approve results or settle.', now(), now()),
  ('RUN_SETTLEMENT', 'OPERATE', 'Run settlement. Not granted to any human role in Phase 1. TODO: holder is unspecified.', now(), now()),
  ('MANAGE_RBAC', 'ADMINISTER', 'Manage role and capability assignment. Endpoint not implemented in Phase 1.', now(), now()),
  ('MANAGE_SYSTEM', 'ADMINISTER', 'Administer system configuration. Does not move escrow.', now(), now());
