import { AppError } from "../shared/errors.js";
import {
  CAPABILITY_PERMISSIONS,
  type CapabilityCode,
  ROLE_PERMISSIONS,
  type RoleCode,
} from "./matrix.js";
import { INDEXER_CONFIRM_ENTRY, type Permission } from "./permissions.js";

export interface GrantSet {
  roles: readonly RoleCode[];
  capabilities: readonly CapabilityCode[];
}

export function grantedPermissions(grants: GrantSet): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of grants.roles) {
    const permissions = ROLE_PERMISSIONS[role];
    if (!permissions) {
      throw new AppError("FORBIDDEN", 403, "Unknown role");
    }
    for (const permission of permissions) {
      out.add(permission);
    }
  }
  for (const capability of grants.capabilities) {
    const permissions = CAPABILITY_PERMISSIONS[capability];
    if (!permissions) {
      throw new AppError("FORBIDDEN", 403, "Unknown capability");
    }
    for (const permission of permissions) {
      out.add(permission);
    }
  }
  return out;
}

export function isAllowed(grants: GrantSet, permission: Permission): boolean {
  if ((permission as string) === INDEXER_CONFIRM_ENTRY) {
    return false;
  }
  return grantedPermissions(grants).has(permission);
}

export function assertAllowed(grants: GrantSet, permission: Permission): void {
  if (!isAllowed(grants, permission)) {
    throw new AppError("FORBIDDEN", 403, "Permission denied");
  }
}
