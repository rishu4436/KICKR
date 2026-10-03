import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { PUBLIC_CONFIG_KEYS } from "../config/types.js";
import { ConfigError } from "../shared/errors.js";
import { toPublicError } from "../shared/errors.js";
import { buildTestApp } from "./helpers.js";

const required = {
  DATABASE_URL: "postgres://kickr:supersecretpassword@localhost:5432/kickr",
  REDIS_URL: "redis://:redis-secret-password@localhost:6379/0",
  AUTH_DOMAIN: "localhost",
  SOLANA_RPC_URL: "https://rpc.example/?api-key=solana-secret-key",
};

describe("config", () => {
  it("rejects missing required env", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: "postgres://localhost/kickr" })).toThrow(/REDIS_URL/);
    expect(() =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/kickr",
        REDIS_URL: "redis://localhost:6379",
      }),
    ).toThrow(/AUTH_DOMAIN/);
    expect(() => loadConfig({ ...required, DATABASE_URL: "" })).toThrow(/DATABASE_URL/);
  });

  it("keeps secrets out of public config", () => {
    const config = loadConfig(required);
    expect(Object.keys(config.public).sort()).toEqual([...PUBLIC_CONFIG_KEYS].sort());
    const serialized = JSON.stringify(config.public);
    expect(serialized).not.toContain("supersecretpassword");
    expect(serialized).not.toContain("redis-secret-password");
    expect(serialized).not.toContain("solana-secret-key");
    expect(serialized).not.toContain("DATABASE_URL");
    expect(serialized).not.toContain("REDIS_URL");
    expect(config.public).not.toHaveProperty("databaseUrl");
    expect(config.public).not.toHaveProperty("redisUrl");
    expect(config.public).not.toHaveProperty("solanaRpcUrl");
    expect(config.secrets.databaseUrl).toContain("supersecretpassword");
    expect(config.server).not.toHaveProperty("databaseUrl");
    for (const key of Object.keys(config.public)) {
      expect(key).not.toMatch(/secret|password|token|database|redis|private/i);
    }
  });

  it("does not return secrets from the public config route", async () => {
    const { app } = buildTestApp(() => new Date("2026-10-03T12:00:00.000Z"));
    const response = await app.request("/v1/config/public");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("supersecretpassword");
    expect(text).not.toContain("redis-secret-password");
    expect(text).not.toContain("solana-secret-key");
  });

  it("hides stack traces and secret messages in production", () => {
    const error = new Error("connect failed postgres://kickr:supersecretpassword@db/kickr");
    error.stack = "Error: supersecretpassword\n    at secretFunction";
    const mapped = toPublicError(error, "production", "corr-1");
    const serialized = JSON.stringify(mapped);
    expect(mapped.status).toBe(500);
    expect(mapped.body.error.message).toBe("Internal error");
    expect(serialized).not.toContain("supersecretpassword");
    expect(serialized).not.toContain("secretFunction");
    expect(serialized).not.toContain("stack");
  });
});
