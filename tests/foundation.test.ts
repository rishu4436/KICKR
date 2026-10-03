import { describe, expect, it } from "vitest";
import { applyMigrations, type MigrationConnection, type MigrationRunner } from "../db/migrate.js";
import { InMemoryRateLimiter } from "../shared/rate-limit.js";
import { redact } from "../shared/redact.js";
import { PHASE1_WORKER_STATUS, FUTURE_SERVICE_NAMES } from "../workers/contracts.js";
import { buildTestApp } from "./helpers.js";

describe("foundation controls", () => {
  it("redacts secrets in structured logs", () => {
    const cleaned = redact({
      password: "supersecretpassword",
      databaseUrl: "postgres://kickr:supersecretpassword@localhost/kickr",
      nested: { authorization: "Bearer abc", note: "ok" },
      message: "failed postgres://kickr:supersecretpassword@localhost/kickr",
    }) as {
      password: string;
      databaseUrl: string;
      nested: { authorization: string; note: string };
      message: string;
    };
    expect(cleaned.password).toBe("[redacted]");
    expect(cleaned.databaseUrl).toBe("[redacted]");
    expect(cleaned.nested.authorization).toBe("[redacted]");
    expect(cleaned.nested.note).toBe("ok");
    expect(cleaned.message).not.toContain("supersecretpassword");
    expect(cleaned.message).toContain("postgres://[redacted]");
  });

  it("limits with the in-memory abstraction", async () => {
    const limiter = new InMemoryRateLimiter(2, 1_000);
    const now = 1_000_000;
    expect((await limiter.consume("auth:local", now)).allowed).toBe(true);
    expect((await limiter.consume("auth:local", now)).allowed).toBe(true);
    expect((await limiter.consume("auth:local", now)).allowed).toBe(false);
    expect((await limiter.consume("auth:local", now + 1_000)).allowed).toBe(true);
  });

  it("applies each migration once on a single connection", async () => {
    const appliedIds: string[] = [];
    const queries: string[] = [];
    const connection: MigrationConnection = {
      async query<T>(sql: string, params?: readonly unknown[]) {
        queries.push(sql);
        if (sql.includes("SELECT id FROM schema_migrations")) {
          return { rows: appliedIds.map((id) => ({ id })) as T[], rowCount: appliedIds.length };
        }
        if (sql.startsWith("INSERT INTO schema_migrations")) {
          appliedIds.push(String(params?.[0]));
        }
        return { rows: [] as T[], rowCount: 0 };
      },
      release() {
        return undefined;
      },
    };
    let connections = 0;
    const runner: MigrationRunner = {
      async connect() {
        connections += 1;
        return connection;
      },
    };
    const files = [
      { id: "001_a.sql", sql: "CREATE TABLE example (id int);" },
      { id: "002_b.sql", sql: "CREATE TABLE other (id int);" },
    ];
    const first = await applyMigrations(runner, files);
    const second = await applyMigrations(runner, files);
    expect(first).toEqual(["001_a.sql", "002_b.sql"]);
    expect(second).toEqual([]);
    expect(connections).toBe(2);
    expect(queries.some((sql) => sql === "BEGIN")).toBe(true);
    expect(queries.some((sql) => sql === "COMMIT")).toBe(true);
  });

  it("keeps workers as contracts and serves liveness without redis authority", async () => {
    expect(PHASE1_WORKER_STATUS).toBe("contracts-only");
    expect(FUTURE_SERVICE_NAMES).toContain("settlement-worker");
    const { app } = buildTestApp(() => new Date("2026-10-03T12:00:00.000Z"));
    const health = await app.request("/health");
    expect(health.status).toBe(200);
    const ready = await app.request("/ready");
    expect(ready.status).toBe(200);
    const body = (await ready.json()) as { redis: { ok: boolean } };
    expect(body.redis.ok).toBe(true);
  });
});
