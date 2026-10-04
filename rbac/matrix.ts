import type { Permission } from "./permissions.js";

/**
 * Planned headcount from the Phase 1 brief. These numbers are organizational
 * intent only. They are NOT database constraints.
 * TODO: whether headcount should be enforced is unspecified.
 */
export const ROLE_HEADCOUNT = {
  CEO_HEAD: 1,
  APP_DEVELOPER: 2,
  BACKEND_DEVELOPER: 1,
  TESTER: 1,
  PRODUCT_MANAGER: 1,
  UI_UX_DEVELOPER: 1,
  SUPPORT: 1,
} as const;

export const ROLES = [
  "CEO_HEAD",
  "APP_DEVELOPER",
  "BACKEND_DEVELOPER",
  "TESTER",
  "PRODUCT_MANAGER",
  "UI_UX_DEVELOPER",
  "SUPPORT",
] as const;

export type RoleCode = (typeof ROLES)[number];

/**
 * REVIEWER is an elevated capability, not a normal broad-access role.
 * It grants REVIEW_RESULT only.
 */
export const CAPABILITIES = ["REVIEWER"] as const;
export type CapabilityCode = (typeof CAPABILITIES)[number];

/**
 * Least-privilege matrix. The code map is authoritative for authorization.
 * The database stores role and capability assignments, not a second matrix.
 *
 * RUN_SETTLEMENT is defined and granted to nobody in Phase 6.
 * Settlement prepare/reconcile APIs require it for ops wiring only.
 * On-chain commit is signed by init_authority offline — not a backend hot wallet.
 * CEO_HEAD explicitly does not execute settlement.
 *
 * REVIEW_RESULT is not on any role. It comes only from the REVIEWER capability.
 * TODO: whether a reviewer also needs READ_CONTEST is unspecified. This map
 * does not add it, because the brief limits the capability to REVIEW_RESULT only.
 */
export const ROLE_PERMISSIONS: Record<RoleCode, readonly Permission[]> = {
  CEO_HEAD: [
    "MANAGE_RBAC",
    "MANAGE_SYSTEM",
    "READ_SYSTEM",
    "READ_AUDIT",
    "READ_CONTEST",
  ],
  BACKEND_DEVELOPER: [
    "READ_SYSTEM",
    "MANAGE_MATCH_CONFIG",
    "MANAGE_CONTEST_CONFIG",
    "RUN_SCORING",
  ],
  APP_DEVELOPER: ["READ_SYSTEM", "READ_CONTEST"],
  TESTER: ["READ_SYSTEM", "READ_CONTEST"],
  PRODUCT_MANAGER: [
    "READ_SYSTEM",
    "READ_CONTEST",
    "MANAGE_CONTEST_CONFIG",
    "MANAGE_MATCH_CONFIG",
  ],
  UI_UX_DEVELOPER: ["READ_SYSTEM"],
  SUPPORT: ["READ_USER_HISTORY", "WRITE_SUPPORT_NOTE", "READ_CONTEST"],
};

export const CAPABILITY_PERMISSIONS: Record<CapabilityCode, readonly Permission[]> = {
  REVIEWER: ["REVIEW_RESULT"],
};

const FORBIDDEN_PERMISSION_NAMES = [
  "MOVE_ESCROW",
  "MOVE_FUNDS",
  "EDIT_SCORE",
  "EDIT_WINNER",
  "MODIFY_AUDIT",
  "DELETE_AUDIT",
  "UPDATE_AUDIT",
  "CONFIRM_ENTRY",
] as const;

export function assertMatrixInvariants(): void {
  const granted = new Set<string>();
  for (const permissions of Object.values(ROLE_PERMISSIONS)) {
    for (const permission of permissions) {
      granted.add(permission);
    }
  }
  for (const permissions of Object.values(CAPABILITY_PERMISSIONS)) {
    for (const permission of permissions) {
      granted.add(permission);
    }
  }
  for (const name of FORBIDDEN_PERMISSION_NAMES) {
    if (granted.has(name)) {
      throw new Error(`Forbidden permission was granted: ${name}`);
    }
  }
  if (granted.has("INDEXER_CONFIRM_ENTRY")) {
    throw new Error("INDEXER_CONFIRM_ENTRY must not be granted to a role or capability");
  }
}

assertMatrixInvariants();
