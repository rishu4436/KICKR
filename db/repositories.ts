import type { AuditQuery } from "../audit/query.js";
import { matchesAuditQuery } from "../audit/query.js";
import type { AuditEvent, AuditEventInput, AuditStore } from "../audit/types.js";
import { parseAuditEventInput } from "../audit/validate.js";
import type {
  AccountRecord,
  AccountRepository,
  LoginNonceRecord,
  NonceRepository,
  SessionRecord,
  SessionRepository,
} from "../auth/types.js";
import type { GrantRepository } from "../rbac/grants.js";
import type { CapabilityCode, RoleCode } from "../rbac/matrix.js";
import { CAPABILITIES, ROLES } from "../rbac/matrix.js";
import { newId } from "../shared/ids.js";
import { asDate, asNullableDate, asNullableString, asString } from "./mappers.js";
import type { Queryable } from "./types.js";

type Row = Record<string, unknown>;

function mapAccount(row: Row): AccountRecord {
  return {
    id: asString(row.id),
    walletAddress: asString(row.wallet_address),
    displayName: asNullableString(row.display_name),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    deletedAt: asNullableDate(row.deleted_at),
  };
}

function mapNonce(row: Row): LoginNonceRecord {
  return {
    id: asString(row.id),
    nonce: asString(row.nonce),
    walletAddress: asString(row.wallet_address),
    domain: asString(row.domain),
    message: asString(row.message),
    expiresAt: asDate(row.expires_at),
    consumedAt: asNullableDate(row.consumed_at),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

function mapSession(row: Row): SessionRecord {
  return {
    id: asString(row.id),
    accountId: asString(row.account_id),
    tokenHash: asString(row.token_hash),
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
    expiresAt: asDate(row.expires_at),
    revokedAt: asNullableDate(row.revoked_at),
  };
}

export function createPgAccountRepository(db: Queryable): AccountRepository {
  return {
    async findById(id: string): Promise<AccountRecord | null> {
      const result = await db.query<Row>(
        `SELECT id, wallet_address, display_name, created_at, updated_at, deleted_at
         FROM accounts WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? mapAccount(row) : null;
    },
    async findByWallet(walletAddress: string): Promise<AccountRecord | null> {
      const result = await db.query<Row>(
        `SELECT id, wallet_address, display_name, created_at, updated_at, deleted_at
         FROM accounts WHERE wallet_address = $1`,
        [walletAddress],
      );
      const row = result.rows[0];
      return row ? mapAccount(row) : null;
    },
    async insert(account: AccountRecord): Promise<AccountRecord> {
      const result = await db.query<Row>(
        `INSERT INTO accounts (id, wallet_address, display_name, created_at, updated_at, deleted_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (wallet_address) DO NOTHING
         RETURNING id, wallet_address, display_name, created_at, updated_at, deleted_at`,
        [
          account.id,
          account.walletAddress,
          account.displayName,
          account.createdAt,
          account.updatedAt,
          account.deletedAt,
        ],
      );
      const row = result.rows[0];
      if (row) {
        return mapAccount(row);
      }
      const existing = await db.query<Row>(
        `SELECT id, wallet_address, display_name, created_at, updated_at, deleted_at
         FROM accounts WHERE wallet_address = $1`,
        [account.walletAddress],
      );
      const found = existing.rows[0];
      if (!found) {
        throw new Error("account insert failed");
      }
      return mapAccount(found);
    },
    async listAll(): Promise<AccountRecord[]> {
      const result = await db.query<Row>(
        `SELECT id, wallet_address, display_name, created_at, updated_at, deleted_at
         FROM accounts
         ORDER BY created_at ASC, id ASC`,
      );
      return result.rows.map((row) => mapAccount(row));
    },
    async suspend(id: string, now: Date): Promise<boolean> {
      const result = await db.query(
        `UPDATE accounts
         SET deleted_at = $2
         WHERE id = $1
           AND deleted_at IS NULL`,
        [id, now],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async updateDisplayName(id: string, displayName: string, now: Date): Promise<AccountRecord | null> {
      const result = await db.query<Row>(
        `UPDATE accounts
         SET display_name = $2, updated_at = $3
         WHERE id = $1 AND deleted_at IS NULL
         RETURNING id, wallet_address, display_name, created_at, updated_at, deleted_at`,
        [id, displayName, now],
      );
      const row = result.rows[0];
      return row ? mapAccount(row) : null;
    },
  };
}

export function createPgNonceRepository(db: Queryable): NonceRepository {
  return {
    async insert(record: LoginNonceRecord): Promise<void> {
      await db.query(
        `INSERT INTO login_nonces (
           id, nonce, wallet_address, domain, message, expires_at, consumed_at, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.nonce,
          record.walletAddress,
          record.domain,
          record.message,
          record.expiresAt,
          record.consumedAt,
          record.createdAt,
          record.updatedAt,
        ],
      );
    },
    async findByNonce(nonce: string): Promise<LoginNonceRecord | null> {
      const result = await db.query<Row>(
        `SELECT id, nonce, wallet_address, domain, message, expires_at, consumed_at, created_at, updated_at
         FROM login_nonces WHERE nonce = $1`,
        [nonce],
      );
      const row = result.rows[0];
      return row ? mapNonce(row) : null;
    },
    async consumeIfValid(nonce: string, now: Date): Promise<boolean> {
      const result = await db.query(
        `UPDATE login_nonces
         SET consumed_at = $2
         WHERE nonce = $1
           AND consumed_at IS NULL
           AND expires_at > $2`,
        [nonce, now],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function createPgSessionRepository(db: Queryable): SessionRepository {
  return {
    async insert(session: SessionRecord): Promise<void> {
      await db.query(
        `INSERT INTO sessions (
           id, account_id, token_hash, created_at, updated_at, expires_at, revoked_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          session.id,
          session.accountId,
          session.tokenHash,
          session.createdAt,
          session.updatedAt,
          session.expiresAt,
          session.revokedAt,
        ],
      );
    },
    async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
      const result = await db.query<Row>(
        `SELECT id, account_id, token_hash, created_at, updated_at, expires_at, revoked_at
         FROM sessions WHERE token_hash = $1`,
        [tokenHash],
      );
      const row = result.rows[0];
      return row ? mapSession(row) : null;
    },
    async findById(sessionId: string): Promise<SessionRecord | null> {
      const result = await db.query<Row>(
        `SELECT id, account_id, token_hash, created_at, updated_at, expires_at, revoked_at
         FROM sessions WHERE id = $1`,
        [sessionId],
      );
      const row = result.rows[0];
      return row ? mapSession(row) : null;
    },
    async listByAccount(accountId: string): Promise<SessionRecord[]> {
      const result = await db.query<Row>(
        `SELECT id, account_id, token_hash, created_at, updated_at, expires_at, revoked_at
         FROM sessions WHERE account_id = $1
         ORDER BY created_at ASC`,
        [accountId],
      );
      return result.rows.map((row) => mapSession(row));
    },
    async revoke(sessionId: string, now: Date): Promise<boolean> {
      const result = await db.query(
        `UPDATE sessions
         SET revoked_at = $2
         WHERE id = $1
           AND revoked_at IS NULL
           AND expires_at > $2`,
        [sessionId, now],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

function isRole(value: string): value is RoleCode {
  return (ROLES as readonly string[]).includes(value);
}

function isCapability(value: string): value is CapabilityCode {
  return (CAPABILITIES as readonly string[]).includes(value);
}

export function createPgGrantRepository(db: Queryable): GrantRepository {
  return {
    async listRoles(accountId: string): Promise<readonly RoleCode[]> {
      const result = await db.query<Row>(
        `SELECT role_code FROM account_roles WHERE account_id = $1 ORDER BY role_code`,
        [accountId],
      );
      return result.rows.map((row) => {
        const code = asString(row.role_code);
        if (!isRole(code)) {
          throw new Error("Unknown role stored in account_roles");
        }
        return code;
      });
    },
    async listCapabilities(accountId: string): Promise<readonly CapabilityCode[]> {
      const result = await db.query<Row>(
        `SELECT capability FROM account_capability_grants WHERE account_id = $1 ORDER BY capability`,
        [accountId],
      );
      return result.rows.map((row) => {
        const code = asString(row.capability);
        if (!isCapability(code)) {
          throw new Error("Unknown capability stored in account_capability_grants");
        }
        return code;
      });
    },
    async grantRole(accountId: string, role: RoleCode): Promise<void> {
      await db.query(
        `INSERT INTO account_roles (account_id, role_code, created_at, updated_at, granted_by_account_id)
         VALUES ($1, $2, now(), now(), NULL)
         ON CONFLICT (account_id, role_code) DO NOTHING`,
        [accountId, role],
      );
    },
    async revokeRole(accountId: string, role: RoleCode): Promise<boolean> {
      const result = await db.query(
        `DELETE FROM account_roles WHERE account_id = $1 AND role_code = $2`,
        [accountId, role],
      );
      return (result.rowCount ?? 0) > 0;
    },
    async grantCapability(accountId: string, capability: CapabilityCode): Promise<void> {
      await db.query(
        `INSERT INTO account_capability_grants (account_id, capability, created_at, updated_at, granted_by_account_id)
         VALUES ($1, $2, now(), now(), NULL)
         ON CONFLICT (account_id, capability) DO NOTHING`,
        [accountId, capability],
      );
    },
    async revokeCapability(accountId: string, capability: CapabilityCode): Promise<boolean> {
      const result = await db.query(
        `DELETE FROM account_capability_grants WHERE account_id = $1 AND capability = $2`,
        [accountId, capability],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

function mapAudit(row: Row): AuditEvent {
  const metadata = row.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("audit metadata is not an object");
  }
  return {
    id: asString(row.id),
    action: asString(row.action) as AuditEvent["action"],
    occurredAt: asDate(row.occurred_at),
    entityType: asString(row.entity_type),
    entityId: asString(row.entity_id),
    metadata: metadata as Record<string, unknown>,
    actorAccountId: asNullableString(row.actor_account_id),
    actorWallet: asNullableString(row.actor_wallet),
    correlationId: asNullableString(row.correlation_id),
    createdAt: asDate(row.created_at),
  };
}

export function createPgAuditStore(db: Queryable): AuditStore {
  return {
    async append(input: AuditEventInput): Promise<AuditEvent> {
      const parsed = parseAuditEventInput(input);
      const id = newId();
      const createdAt = parsed.occurredAt;
      const result = await db.query<Row>(
        `INSERT INTO audit_events (
           id, actor_account_id, actor_wallet, action, occurred_at,
           entity_type, entity_id, metadata, correlation_id, created_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
         RETURNING id, actor_account_id, actor_wallet, action, occurred_at,
                   entity_type, entity_id, metadata, correlation_id, created_at`,
        [
          id,
          parsed.actorAccountId,
          parsed.actorWallet,
          parsed.action,
          parsed.occurredAt,
          parsed.entityType,
          parsed.entityId,
          JSON.stringify(parsed.metadata),
          parsed.correlationId,
          createdAt,
        ],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error("audit insert returned no row");
      }
      return mapAudit(row);
    },
    async list(limit: number): Promise<readonly AuditEvent[]> {
      const result = await db.query<Row>(
        `SELECT id, actor_account_id, actor_wallet, action, occurred_at,
                entity_type, entity_id, metadata, correlation_id, created_at
         FROM audit_events
         ORDER BY occurred_at ASC, id ASC
         LIMIT $1`,
        [limit],
      );
      return result.rows.map((row) => mapAudit(row));
    },
    async query(filter: AuditQuery): Promise<readonly AuditEvent[]> {
      const result = await db.query<Row>(
        `SELECT id, actor_account_id, actor_wallet, action, occurred_at,
                entity_type, entity_id, metadata, correlation_id, created_at
         FROM audit_events
         ORDER BY occurred_at ASC, id ASC
         LIMIT 1000`,
      );
      return result.rows
        .map((row) => mapAudit(row))
        .filter((event) => matchesAuditQuery(event, filter))
        .slice(-filter.limit);
    },
  };
}
