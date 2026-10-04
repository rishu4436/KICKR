import type { AuditStore } from "../audit/types.js";
import type { AuthService } from "../auth/service.js";
import { grantedPermissions } from "../rbac/authorize.js";
import type { GrantRepository } from "../rbac/grants.js";
import { CAPABILITIES, ROLES, type CapabilityCode, type RoleCode } from "../rbac/matrix.js";
import { opsCapabilitiesFor } from "../rbac/ops-capabilities.js";
import { AppError } from "../shared/errors.js";

export interface OpsAccessDeps {
  auth: AuthService;
  grants: GrantRepository;
  audit: AuditStore;
}

export interface OpsActor {
  accountId: string;
  walletAddress: string;
  correlationId: string | null;
  now: Date;
}

function assertNotSelf(actor: OpsActor, accountId: string): void {
  if (actor.accountId === accountId) {
    throw new AppError("FORBIDDEN", 403, "Ordinary staff cannot change their own access");
  }
}

async function assertNoSettlementAuthority(grants: GrantRepository, accountId: string): Promise<void> {
  const [roles, capabilities] = await Promise.all([
    grants.listRoles(accountId),
    grants.listCapabilities(accountId),
  ]);
  if (grantedPermissions({ roles, capabilities }).has("RUN_SETTLEMENT")) {
    throw new AppError("SETTLEMENT_AUTHORITY_DENIED", 403, "RUN_SETTLEMENT cannot be granted");
  }
}

async function audit(
  deps: OpsAccessDeps,
  actor: OpsActor,
  action:
    | "ROLE_GRANTED"
    | "ROLE_REMOVED"
    | "CAPABILITY_GRANTED"
    | "CAPABILITY_REMOVED"
    | "ACCOUNT_SUSPENDED"
    | "SESSION_REVOKED"
    | "PERMISSION_DENIED",
  entityType: string,
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await deps.audit.append({
    action,
    occurredAt: actor.now,
    entityType,
    entityId,
    metadata,
    actorAccountId: actor.accountId,
    actorWallet: actor.walletAddress,
    correlationId: actor.correlationId,
  });
}

export async function listOpsMembers(deps: OpsAccessDeps, now: Date) {
  const accounts = await deps.auth.listAccounts();
  const members = [];
  for (const account of accounts) {
    const [roles, capabilities, sessions] = await Promise.all([
      deps.grants.listRoles(account.id),
      deps.grants.listCapabilities(account.id),
      deps.auth.listSessions(account.id),
    ]);
    if (roles.length === 0 && capabilities.length === 0) {
      continue;
    }
    const permissions = grantedPermissions({ roles, capabilities });
    const activeSessions = sessions.filter(
      (session) => !session.revokedAt && session.expiresAt > now,
    );
    members.push({
      accountId: account.id,
      walletAddress: account.walletAddress,
      roles,
      capabilities,
      capabilityClasses: opsCapabilitiesFor(permissions),
      status: account.deletedAt ? "SUSPENDED" : "ACTIVE",
      lastActivityAt: null,
      lastActivityAvailable: false,
      scope: "platform",
      scopeNote: "Assignments are account-wide. No narrower resource scope is stored.",
      activeSessions: activeSessions.length,
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        createdAt: session.createdAt.toISOString(),
        expiresAt: session.expiresAt.toISOString(),
        revokedAt: session.revokedAt ? session.revokedAt.toISOString() : null,
        authMode: "solana_wallet",
      })),
    });
  }
  return members;
}

export async function grantOpsRole(
  deps: OpsAccessDeps,
  actor: OpsActor,
  accountId: string,
  role: RoleCode,
): Promise<{ accountId: string; role: RoleCode; changed: true }> {
  assertNotSelf(actor, accountId);
  if (!(ROLES as readonly string[]).includes(role)) {
    throw new AppError("VALIDATION", 400, "Unknown role");
  }
  const account = await deps.auth.findAccount(accountId);
  if (!account || account.deletedAt) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  await deps.grants.grantRole(accountId, role);
  try {
    await assertNoSettlementAuthority(deps.grants, accountId);
  } catch (error) {
    await deps.grants.revokeRole(accountId, role);
    throw error;
  }
  await audit(deps, actor, "ROLE_GRANTED", "ACCOUNT", accountId, {
    role,
    result: "granted",
    targetWallet: account.walletAddress,
  });
  return { accountId, role, changed: true };
}

export async function removeOpsRole(
  deps: OpsAccessDeps,
  actor: OpsActor,
  accountId: string,
  role: RoleCode,
): Promise<{ accountId: string; role: RoleCode; changed: true }> {
  assertNotSelf(actor, accountId);
  const removed = await deps.grants.revokeRole(accountId, role);
  if (!removed) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  await audit(deps, actor, "ROLE_REMOVED", "ACCOUNT", accountId, {
    role,
    result: "removed",
  });
  return { accountId, role, changed: true };
}

export async function grantOpsCapability(
  deps: OpsAccessDeps,
  actor: OpsActor,
  accountId: string,
  capability: CapabilityCode,
): Promise<{ accountId: string; capability: CapabilityCode; changed: true }> {
  assertNotSelf(actor, accountId);
  if (!(CAPABILITIES as readonly string[]).includes(capability)) {
    throw new AppError("VALIDATION", 400, "Unknown capability");
  }
  const account = await deps.auth.findAccount(accountId);
  if (!account || account.deletedAt) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  await deps.grants.grantCapability(accountId, capability);
  try {
    await assertNoSettlementAuthority(deps.grants, accountId);
  } catch (error) {
    await deps.grants.revokeCapability(accountId, capability);
    throw error;
  }
  await audit(deps, actor, "CAPABILITY_GRANTED", "ACCOUNT", accountId, {
    capability,
    result: "granted",
    targetWallet: account.walletAddress,
  });
  return { accountId, capability, changed: true };
}

export async function removeOpsCapability(
  deps: OpsAccessDeps,
  actor: OpsActor,
  accountId: string,
  capability: CapabilityCode,
): Promise<{ accountId: string; capability: CapabilityCode; changed: true }> {
  assertNotSelf(actor, accountId);
  const removed = await deps.grants.revokeCapability(accountId, capability);
  if (!removed) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  await audit(deps, actor, "CAPABILITY_REMOVED", "ACCOUNT", accountId, {
    capability,
    result: "removed",
  });
  return { accountId, capability, changed: true };
}

export async function suspendOpsAccount(
  deps: OpsAccessDeps,
  actor: OpsActor,
  accountId: string,
): Promise<{ accountId: string; status: "SUSPENDED" }> {
  assertNotSelf(actor, accountId);
  const account = await deps.auth.findAccount(accountId);
  if (!account) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  const suspended = await deps.auth.suspendAccount(accountId, actor.now);
  if (!suspended && !account.deletedAt) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  const sessions = await deps.auth.listSessions(accountId);
  for (const session of sessions) {
    if (session.revokedAt) {
      continue;
    }
    const revoked = await deps.auth.revokeSessionById(session.id, actor.now);
    if (revoked) {
      await audit(deps, actor, "SESSION_REVOKED", "SESSION", session.id, {
        accountId,
        result: "revoked",
        reason: "account_suspended",
      });
    }
  }
  await audit(deps, actor, "ACCOUNT_SUSPENDED", "ACCOUNT", accountId, {
    result: "suspended",
    targetWallet: account.walletAddress,
  });
  return { accountId, status: "SUSPENDED" };
}

export async function revokeOpsSession(
  deps: OpsAccessDeps,
  actor: OpsActor,
  sessionId: string,
): Promise<{ sessionId: string; revoked: true }> {
  const session = await deps.auth.findSession(sessionId);
  if (!session) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  assertNotSelf(actor, session.accountId);
  const revoked = await deps.auth.revokeSessionById(sessionId, actor.now);
  if (!revoked) {
    throw new AppError("AUTH_SESSION_REVOKED", 409, "Session has been revoked");
  }
  await audit(deps, actor, "SESSION_REVOKED", "SESSION", sessionId, {
    accountId: session.accountId,
    result: "revoked",
  });
  return { sessionId, revoked: true };
}
