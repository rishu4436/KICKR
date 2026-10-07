import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowed } from "../rbac/authorize.js";
import {
  CAPABILITY_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLES,
  type RoleCode,
} from "../rbac/matrix.js";
import {
  INDEXER_CONFIRM_ENTRY,
  PERMISSION_CATALOG,
  PERMISSIONS,
  SENSITIVE_PERMISSIONS,
  type Permission,
} from "../rbac/permissions.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";

function allows(role: RoleCode, permission: Permission): boolean {
  return isAllowed({ roles: [role], capabilities: [] }, permission);
}

describe("rbac matrix", () => {
  it("allows a granted permission and denies one that is not granted", () => {
    expect(allows("CEO_HEAD", "READ_AUDIT")).toBe(true);
    expect(allows("CEO_HEAD", "RUN_SETTLEMENT")).toBe(false);
    expect(allows("SUPPORT", "WRITE_SUPPORT_NOTE")).toBe(true);
    expect(allows("SUPPORT", "MANAGE_SYSTEM")).toBe(false);
  });

  it("does not let support administer or modify audit history", () => {
    expect(allows("SUPPORT", "MANAGE_RBAC")).toBe(false);
    expect(allows("SUPPORT", "MANAGE_SYSTEM")).toBe(false);
    expect(allows("SUPPORT", "READ_AUDIT")).toBe(false);
    const support = new Set(ROLE_PERMISSIONS.SUPPORT);
    for (const permission of support) {
      expect(permission).not.toMatch(/AUDIT|SCORE|WINNER|SETTLEMENT|ESCROW|MONEY|PAYOUT/);
    }
    expect([...support].sort()).toEqual(
      ["READ_CONTEST", "READ_USER_HISTORY", "WRITE_SUPPORT_NOTE"].sort(),
    );
  });

  it("does not let developers approve settlement or review results", () => {
    for (const role of ["BACKEND_DEVELOPER", "APP_DEVELOPER"] as const) {
      expect(allows(role, "RUN_SETTLEMENT")).toBe(false);
      expect(allows(role, "REVIEW_RESULT")).toBe(false);
    }
    expect(allows("BACKEND_DEVELOPER", "RUN_SCORING")).toBe(true);
    expect(allows("APP_DEVELOPER", "RUN_SCORING")).toBe(false);
  });

  it("does not let UI/UX reach sensitive operations", () => {
    expect([...ROLE_PERMISSIONS.UI_UX_DEVELOPER]).toEqual(["READ_SYSTEM"]);
    for (const permission of SENSITIVE_PERMISSIONS) {
      expect(allows("UI_UX_DEVELOPER", permission)).toBe(false);
    }
  });

  it("grants REVIEW_RESULT only through the REVIEWER capability", () => {
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role]).not.toContain("REVIEW_RESULT");
    }
    expect(isAllowed({ roles: [], capabilities: ["REVIEWER"] }, "REVIEW_RESULT")).toBe(true);
    expect(isAllowed({ roles: [], capabilities: ["REVIEWER"] }, "READ_SYSTEM")).toBe(false);
    expect(isAllowed({ roles: [], capabilities: ["REVIEWER"] }, "RUN_SETTLEMENT")).toBe(false);
    expect(CAPABILITY_PERMISSIONS.REVIEWER).toEqual(["REVIEW_RESULT"]);
  });

  it("has no escrow movement permission and does not grant entry confirmation", () => {
    for (const definition of PERMISSION_CATALOG) {
      expect(definition.touchesEscrow).toBe(false);
      expect(definition.code).not.toMatch(/ESCROW|MOVE_FUND|PAYOUT/);
    }
    const catalog = new Set<string>(PERMISSIONS);
    expect(catalog.has("MOVE_ESCROW")).toBe(false);
    expect(catalog.has(INDEXER_CONFIRM_ENTRY)).toBe(false);
    for (const role of ROLES) {
      expect(ROLE_PERMISSIONS[role] as readonly string[]).not.toContain(INDEXER_CONFIRM_ENTRY);
      expect(ROLE_PERMISSIONS[role]).not.toContain("RUN_SETTLEMENT");
    }
    expect(isAllowed({ roles: ["CEO_HEAD"], capabilities: ["REVIEWER"] }, "RUN_SCORING")).toBe(false);
  });

  it("matches the permission and role catalog stored in the migration", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "migrations/001_phase1_identity_rbac_audit.sql"),
      "utf8",
    );
    const sql19 = readFileSync(
      path.resolve(process.cwd(), "migrations/019_phase18d2_match_operations.sql"),
      "utf8",
    );
    for (const permission of PERMISSIONS) {
      if (permission === "MANAGE_MATCH_OPERATIONS") {
        expect(sql19).toContain(`'${permission}'`);
      } else {
        expect(sql).toContain(`'${permission}'`);
      }
    }
    for (const role of ROLES) {
      expect(sql).toContain(`'${role}'`);
    }
    const permissionInsert = sql.split("INSERT INTO permissions")[1] ?? "";
    expect(permissionInsert).not.toContain("INDEXER_CONFIRM_ENTRY");
    expect(permissionInsert).not.toContain("MOVE_ESCROW");
    expect(sql).toContain("permissions_no_escrow");
  });

  it("enforces READ_SYSTEM and READ_AUDIT on HTTP routes", async () => {
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
    const headers = { authorization: `Bearer ${login.token}` };

    const denied = await app.request("/v1/system/status", { headers });
    expect(denied.status).toBe(403);

    grants.grantRole(login.account.id, "SUPPORT");
    const supportSystem = await app.request("/v1/system/status", { headers });
    expect(supportSystem.status).toBe(403);
    const supportAudit = await app.request("/v1/audit/events", { headers });
    expect(supportAudit.status).toBe(403);

    grants.grantRole(login.account.id, "UI_UX_DEVELOPER");
    const ui = await app.request("/v1/system/status", { headers });
    expect(ui.status).toBe(200);
    const uiAudit = await app.request("/v1/audit/events", { headers });
    expect(uiAudit.status).toBe(403);

    grants.grantRole(login.account.id, "CEO_HEAD");
    const audit = await app.request("/v1/audit/events", { headers });
    expect(audit.status).toBe(200);
  });
});
