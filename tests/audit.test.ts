import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUDIT_EVENTS } from "../audit/events.js";
import { deleteAuditEvent, updateAuditEvent } from "../audit/guard.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import { AppError } from "../shared/errors.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";

const complete = {
  action: "TEAM_SAVED" as const,
  occurredAt: new Date("2026-10-03T12:00:00.000Z"),
  entityType: "TEAM",
  entityId: "team-1",
  metadata: { source: "test" },
  actorAccountId: null,
  actorWallet: null,
  correlationId: "corr-audit",
};

describe("audit log", () => {
  it("appends an event with the required fields", async () => {
    const store = new InMemoryAuditStore();
    const stored = await store.append(complete);
    expect(stored.id).toBeTruthy();
    expect(stored.action).toBe("TEAM_SAVED");
    expect(stored.occurredAt.toISOString()).toBe("2026-10-03T12:00:00.000Z");
    expect(stored.entityType).toBe("TEAM");
    expect(stored.entityId).toBe("team-1");
    expect(stored.metadata).toEqual({ source: "test" });
    expect(stored.correlationId).toBe("corr-audit");
    const listed = await store.list(10);
    expect(listed).toHaveLength(1);
  });

  it("rejects an event without metadata", async () => {
    const store = new InMemoryAuditStore();
    const broken = { ...complete, metadata: undefined };
    await expect(store.append(broken as unknown as typeof complete)).rejects.toBeInstanceOf(AppError);
  });

  it("rejects update and delete in the application", () => {
    expect(() => updateAuditEvent()).toThrow(/UPDATE of audit_events is forbidden/);
    expect(() => deleteAuditEvent()).toThrow(/DELETE of audit_events is forbidden/);
  });

  it("rejects update and delete in the database migration", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "migrations/001_phase1_identity_rbac_audit.sql"),
      "utf8",
    );
    expect(sql).toContain("audit_events is append-only");
    expect(sql).toContain("BEFORE UPDATE ON audit_events");
    expect(sql).toContain("BEFORE DELETE ON audit_events");
    expect(sql).toContain("REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC");
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION[^\n]*update_audit/i);
    for (const name of AUDIT_EVENTS) {
      expect(sql).toContain(`'${name}'`);
    }
  });

  it("does not expose audit mutation routes", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const { app, deps, grants } = buildTestApp(() => now);
    const wallet = generateWallet();
    const issued = await deps.auth.issueNonce(wallet.publicKey, { now, correlationId: null });
    const login = await deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, wallet.secretKey),
      },
      { now, correlationId: null },
    );
    grants.grantRole(login.account.id, "CEO_HEAD");
    const headers = {
      authorization: `Bearer ${login.token}`,
      "content-type": "application/json",
    };
    const patch = await app.request("/v1/audit/events/event-1", {
      method: "PATCH",
      headers,
      body: JSON.stringify({ action: "ACCOUNT_LOGIN" }),
    });
    const del = await app.request("/v1/audit/events/event-1", { method: "DELETE", headers });
    expect(patch.status).toBe(404);
    expect(del.status).toBe(404);
  });
});
