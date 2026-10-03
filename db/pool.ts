import pg from "pg";
import type { MigrationConnection, MigrationRunner } from "./migrate.js";
import type { Queryable } from "./types.js";

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl });
}

export function asQueryable(pool: pg.Pool): Queryable {
  return {
    async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
      const result = await pool.query(sql, params ? [...params] : undefined);
      return { rows: result.rows as T[], rowCount: result.rowCount };
    },
  };
}

export function asMigrationRunner(pool: pg.Pool): MigrationRunner {
  return {
    async connect(): Promise<MigrationConnection> {
      const client = await pool.connect();
      return {
        async query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]) {
          const result = await client.query(sql, params ? [...params] : undefined);
          return { rows: result.rows as T[], rowCount: result.rowCount };
        },
        release(): void {
          client.release();
        },
      };
    },
  };
}
