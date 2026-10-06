import { AppError } from "../shared/errors.js";
import type { IdempotencyStore } from "../shared/reliability.js";
import type { Queryable } from "./types.js";

type Row = { request_hash: string; response_status: number; response_body: unknown };

/**
 * Postgres is authoritative for idempotency records.
 * A unique (scope, key) constraint rejects conflicting concurrent inserts.
 */
export function createPgIdempotencyStore(db: Queryable): IdempotencyStore {
  return {
    async run(scope, key, requestHash, exec) {
      if (!key) {
        const result = await exec();
        return { ...result, replay: false };
      }
      const existing = await db.query<Row>(
        `SELECT request_hash, response_status, response_body
         FROM idempotency_records
         WHERE scope = $1 AND idempotency_key = $2`,
        [scope, key],
      );
      const row = existing.rows[0];
      if (row) {
        return replay(row, requestHash);
      }
      const inserted = await db.query(
        `INSERT INTO idempotency_records (scope, idempotency_key, request_hash, response_status, response_body)
         VALUES ($1, $2, $3, 0, '{"pending":true}'::jsonb)
         ON CONFLICT (scope, idempotency_key) DO NOTHING`,
        [scope, key, requestHash],
      );
      if ((inserted.rowCount ?? 0) !== 1) {
        const again = await db.query<Row>(
          `SELECT request_hash, response_status, response_body
           FROM idempotency_records
           WHERE scope = $1 AND idempotency_key = $2`,
          [scope, key],
        );
        const raced = again.rows[0];
        if (!raced) {
          throw new AppError("DEPENDENCY_UNAVAILABLE", 503, "Idempotency store unavailable", { expose: true });
        }
        if (raced.response_status === 0) {
          throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key is already in progress");
        }
        return replay(raced, requestHash);
      }
      try {
        const result = await exec();
        await db.query(
          `UPDATE idempotency_records
           SET response_status = $3, response_body = $4::jsonb
           WHERE scope = $1 AND idempotency_key = $2 AND response_status = 0`,
          [scope, key, result.status, JSON.stringify(result.body)],
        );
        return { ...result, replay: false };
      } catch (error) {
        await db.query(
          `DELETE FROM idempotency_records
           WHERE scope = $1 AND idempotency_key = $2 AND response_status = 0`,
          [scope, key],
        );
        throw error;
      }
    },
  };
}

function replay<T>(row: Row, requestHash: string): { status: number; body: T; replay: boolean } {
  if (row.request_hash !== requestHash) {
    throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key was reused with a different request");
  }
  if (row.response_status === 0) {
    throw new AppError("IDEMPOTENCY_CONFLICT", 409, "Idempotency key is already in progress");
  }
  return { status: row.response_status, body: row.response_body as T, replay: true };
}
