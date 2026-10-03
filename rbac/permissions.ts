/**
 * Explicit permissions. There is no "admin can do everything" permission.
 *
 * INDEXER_CONFIRM_ENTRY is intentionally NOT in this list. Entry confirmation
 * is not grantable to any API, support, or other human role. Only a future
 * program/indexer path may hold it. It is not seeded into the permissions table.
 *
 * There is no MOVE_ESCROW (or any equivalent) permission. No application role
 * may directly move escrow funds. RUN_SCORING does not imply escrow access.
 */

export const PERMISSIONS = [
  "READ_SYSTEM",
  "READ_CONTEST",
  "READ_USER_HISTORY",
  "WRITE_SUPPORT_NOTE",
  "READ_AUDIT",
  "MANAGE_MATCH_CONFIG",
  "MANAGE_CONTEST_CONFIG",
  "REVIEW_RESULT",
  "RUN_SCORING",
  "RUN_SETTLEMENT",
  "MANAGE_RBAC",
  "MANAGE_SYSTEM",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const PERMISSION_GROUPS = ["READ", "OPERATE", "APPROVE", "ADMINISTER"] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface PermissionDefinition {
  code: Permission;
  group: PermissionGroup;
  /** Always false. No permission in Phase 1 may move escrow. */
  touchesEscrow: false;
  description: string;
}

export const PERMISSION_CATALOG: readonly PermissionDefinition[] = [
  {
    code: "READ_SYSTEM",
    group: "READ",
    touchesEscrow: false,
    description: "Read non-sensitive system status.",
  },
  {
    code: "READ_CONTEST",
    group: "READ",
    touchesEscrow: false,
    description: "Read contest records.",
  },
  {
    code: "READ_USER_HISTORY",
    group: "READ",
    touchesEscrow: false,
    description: "Read a user history view. Does not modify money, scores, or winners.",
  },
  {
    code: "WRITE_SUPPORT_NOTE",
    group: "OPERATE",
    touchesEscrow: false,
    description:
      "Write a support note. Does not modify audit history, scores, winners, or money. Note storage is TODO.",
  },
  {
    code: "READ_AUDIT",
    group: "READ",
    touchesEscrow: false,
    description: "Read the append-only audit log. Does not permit update or delete.",
  },
  {
    code: "MANAGE_MATCH_CONFIG",
    group: "OPERATE",
    touchesEscrow: false,
    description: "Manage match configuration. Does not score, settle, or move funds.",
  },
  {
    code: "MANAGE_CONTEST_CONFIG",
    group: "OPERATE",
    touchesEscrow: false,
    description: "Manage contest configuration. Does not settle or move funds.",
  },
  {
    code: "REVIEW_RESULT",
    group: "APPROVE",
    touchesEscrow: false,
    description:
      "Approve or reject a review. Granted only via the REVIEWER capability, not via a normal role.",
  },
  {
    code: "RUN_SCORING",
    group: "OPERATE",
    touchesEscrow: false,
    description: "Run scoring. Must not touch escrow, approve a review, or settle.",
  },
  {
    code: "RUN_SETTLEMENT",
    group: "OPERATE",
    touchesEscrow: false,
    description:
      "Run settlement. Not granted to any human role in Phase 1. Must not be backed by a key that can arbitrarily move the contest pot.",
  },
  {
    code: "MANAGE_RBAC",
    group: "ADMINISTER",
    touchesEscrow: false,
    description: "Manage role and capability assignment. No writer endpoint exists in Phase 1.",
  },
  {
    code: "MANAGE_SYSTEM",
    group: "ADMINISTER",
    touchesEscrow: false,
    description: "Administer system configuration. Does not move escrow.",
  },
];

/**
 * Reserved for a future on-chain program / indexer path.
 * Not a role permission. Not granted to SUPPORT or any other human role.
 * Not accepted by authorize().
 */
export const INDEXER_CONFIRM_ENTRY = "INDEXER_CONFIRM_ENTRY" as const;

export const SENSITIVE_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (permission) => permission !== "READ_SYSTEM",
);
