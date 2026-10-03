import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Queryable } from "./types.js";

export interface MigrationFile {
  id: string;
  sql: string;
}

export interface MigrationConnection extends Queryable {
  release(): void;
}

export interface MigrationRunner {
  connect(): Promise<MigrationConnection>;
}

export async function loadMigrationFiles(directory: string): Promise<MigrationFile[]> {
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const sql = await readFile(path.join(directory, name), "utf8");
    files.push({ id: name, sql });
  }
  return files;
}

/**
 * Apply pending SQL migrations on a single connection.
 * schema_migrations is created by the runner, not by a migration file.
 */
export async function applyMigrations(
  runner: MigrationRunner,
  files: readonly MigrationFile[],
): Promise<string[]> {
  const db = await runner.connect();
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const existing = await db.query<{ id: string }>("SELECT id FROM schema_migrations");
    const done = new Set(existing.rows.map((row) => row.id));
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file.id)) {
        continue;
      }
      await db.query("BEGIN");
      try {
        await db.query(file.sql);
        await db.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file.id]);
        await db.query("COMMIT");
        applied.push(file.id);
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      }
    }
    return applied;
  } finally {
    db.release();
  }
}
