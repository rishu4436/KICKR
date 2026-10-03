import path from "node:path";
import { loadConfig } from "../config/load.js";
import { applyMigrations, loadMigrationFiles } from "./migrate.js";
import { asMigrationRunner, createPool } from "./pool.js";

/**
 * Apply migrations using DATABASE_URL. Run from the repository root.
 * Usage: npm run db:migrate
 */
const config = loadConfig(process.env);
const pool = createPool(config.secrets.databaseUrl);

try {
  const files = await loadMigrationFiles(path.resolve(process.cwd(), "migrations"));
  const applied = await applyMigrations(asMigrationRunner(pool), files);
  console.log(applied.length === 0 ? "No pending migrations" : `Applied: ${applied.join(", ")}`);
} finally {
  await pool.end();
}
