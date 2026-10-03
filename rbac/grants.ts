import type { CapabilityCode, RoleCode } from "./matrix.js";

export interface GrantRepository {
  listRoles(accountId: string): Promise<readonly RoleCode[]>;
  listCapabilities(accountId: string): Promise<readonly CapabilityCode[]>;
}

/** Test double. Role assignment has no HTTP writer in Phase 1. */
export class InMemoryGrantRepository implements GrantRepository {
  private readonly roles = new Map<string, RoleCode[]>();
  private readonly capabilities = new Map<string, CapabilityCode[]>();

  grantRole(accountId: string, role: RoleCode): void {
    const current = this.roles.get(accountId) ?? [];
    if (!current.includes(role)) {
      current.push(role);
    }
    this.roles.set(accountId, current);
  }

  grantCapability(accountId: string, capability: CapabilityCode): void {
    const current = this.capabilities.get(accountId) ?? [];
    if (!current.includes(capability)) {
      current.push(capability);
    }
    this.capabilities.set(accountId, current);
  }

  async listRoles(accountId: string): Promise<readonly RoleCode[]> {
    return [...(this.roles.get(accountId) ?? [])];
  }

  async listCapabilities(accountId: string): Promise<readonly CapabilityCode[]> {
    return [...(this.capabilities.get(accountId) ?? [])];
  }
}
