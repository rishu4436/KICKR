import type { CapabilityCode, RoleCode } from "./matrix.js";

export interface GrantRepository {
  listRoles(accountId: string): Promise<readonly RoleCode[]>;
  listCapabilities(accountId: string): Promise<readonly CapabilityCode[]>;
  grantRole(accountId: string, role: RoleCode): Promise<void>;
  revokeRole(accountId: string, role: RoleCode): Promise<boolean>;
  grantCapability(accountId: string, capability: CapabilityCode): Promise<void>;
  revokeCapability(accountId: string, capability: CapabilityCode): Promise<boolean>;
}

/** Test double. Role assignment has no HTTP writer in Phase 1. */
export class InMemoryGrantRepository implements GrantRepository {
  private readonly roles = new Map<string, RoleCode[]>();
  private readonly capabilities = new Map<string, CapabilityCode[]>();

  async grantRole(accountId: string, role: RoleCode): Promise<void> {
    const current = this.roles.get(accountId) ?? [];
    if (!current.includes(role)) {
      current.push(role);
    }
    this.roles.set(accountId, current);
  }

  async revokeRole(accountId: string, role: RoleCode): Promise<boolean> {
    const current = this.roles.get(accountId) ?? [];
    const next = current.filter((item) => item !== role);
    this.roles.set(accountId, next);
    return next.length !== current.length;
  }

  async grantCapability(accountId: string, capability: CapabilityCode): Promise<void> {
    const current = this.capabilities.get(accountId) ?? [];
    if (!current.includes(capability)) {
      current.push(capability);
    }
    this.capabilities.set(accountId, current);
  }

  async revokeCapability(accountId: string, capability: CapabilityCode): Promise<boolean> {
    const current = this.capabilities.get(accountId) ?? [];
    const next = current.filter((item) => item !== capability);
    this.capabilities.set(accountId, next);
    return next.length !== current.length;
  }

  async listRoles(accountId: string): Promise<readonly RoleCode[]> {
    return [...(this.roles.get(accountId) ?? [])];
  }

  async listCapabilities(accountId: string): Promise<readonly CapabilityCode[]> {
    return [...(this.capabilities.get(accountId) ?? [])];
  }
}
