import type { Permission } from "./permissions.js";

/**
 * Operations Control Center capability classes.
 * These are not a second grant system. Each class is satisfied only by
 * permissions that already exist on the role/capability matrix.
 * The UI renders these classes. It does not decide access.
 *
 * RUN_SETTLEMENT maps only to RUN_SETTLEMENT, which the matrix grants to nobody.
 */
export const OPS_CAPABILITY_CLASSES = [
  "READ_PLATFORM",
  "READ_MATCHES",
  "READ_CONTESTS",
  "READ_ENTRIES",
  "READ_SETTLEMENTS",
  "READ_CLAIMS",
  "READ_AUDIT",
  "READ_DIAGNOSTICS",
  "MANAGE_MATCHES",
  "MANAGE_CONTESTS",
  "MANAGE_USERS",
  "MANAGE_PROVIDER_CONFIG",
  "MANAGE_FEATURE_FLAGS",
  "RUN_SCORING",
  "REVIEW_RESULT",
  "RUN_SETTLEMENT",
] as const;

export type OpsCapabilityClass = (typeof OPS_CAPABILITY_CLASSES)[number];

/**
 * A class is held when the principal already holds any listed permission.
 * Manage permissions also satisfy the matching read so an operator can see
 * the resource they are allowed to configure. They do not add new powers.
 */
export const OPS_CAPABILITY_SOURCES: Record<OpsCapabilityClass, readonly Permission[]> = {
  READ_PLATFORM: ["READ_SYSTEM"],
  READ_MATCHES: ["READ_SYSTEM", "MANAGE_MATCH_CONFIG"],
  READ_CONTESTS: ["READ_CONTEST", "MANAGE_CONTEST_CONFIG"],
  READ_ENTRIES: ["READ_USER_HISTORY", "READ_CONTEST"],
  READ_SETTLEMENTS: ["READ_CONTEST", "RUN_SCORING", "REVIEW_RESULT"],
  READ_CLAIMS: ["READ_CONTEST", "READ_USER_HISTORY"],
  READ_AUDIT: ["READ_AUDIT"],
  READ_DIAGNOSTICS: ["READ_SYSTEM"],
  MANAGE_MATCHES: ["MANAGE_MATCH_CONFIG"],
  MANAGE_CONTESTS: ["MANAGE_CONTEST_CONFIG"],
  MANAGE_USERS: ["MANAGE_RBAC"],
  MANAGE_PROVIDER_CONFIG: ["MANAGE_SYSTEM"],
  MANAGE_FEATURE_FLAGS: ["MANAGE_SYSTEM"],
  RUN_SCORING: ["RUN_SCORING"],
  REVIEW_RESULT: ["REVIEW_RESULT"],
  RUN_SETTLEMENT: ["RUN_SETTLEMENT"],
};

export function opsCapabilitiesFor(permissions: ReadonlySet<Permission>): OpsCapabilityClass[] {
  const held: OpsCapabilityClass[] = [];
  for (const capability of OPS_CAPABILITY_CLASSES) {
    if (hasOpsCapability(permissions, capability)) {
      held.push(capability);
    }
  }
  return held;
}

export function hasOpsCapability(
  permissions: ReadonlySet<Permission>,
  capability: OpsCapabilityClass,
): boolean {
  const sources = OPS_CAPABILITY_SOURCES[capability];
  for (const permission of sources) {
    if (permissions.has(permission)) {
      return true;
    }
  }
  return false;
}
