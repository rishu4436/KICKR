import type { AuditEventName } from "./events.js";
import type { AuditEvent } from "./types.js";

export interface AuditQuery {
  limit: number;
  actorAccountId?: string;
  action?: AuditEventName;
  entityType?: string;
  entityId?: string;
  from?: Date;
  to?: Date;
  failuresOnly?: boolean;
  permissionDenialsOnly?: boolean;
}

const FAILURE_ACTIONS = new Set<string>([
  "SETTLEMENT_FAILED",
  "DEPOSIT_REJECTED",
  "RESULT_REJECTED",
  "MATCH_EVENT_REJECTED",
  "REVIEW_REJECTED",
]);

export function auditResult(event: AuditEvent): string {
  const value = event.metadata.result;
  return typeof value === "string" && value.length > 0 ? value : "recorded";
}

export function isPermissionDenial(event: AuditEvent): boolean {
  return event.action === "PERMISSION_DENIED" || auditResult(event) === "denied";
}

export function isFailureEvent(event: AuditEvent): boolean {
  const result = auditResult(event);
  return FAILURE_ACTIONS.has(event.action) || result === "failure" || result === "denied";
}

export function matchesAuditQuery(event: AuditEvent, query: AuditQuery): boolean {
  if (query.actorAccountId && event.actorAccountId !== query.actorAccountId) {
    return false;
  }
  if (query.action && event.action !== query.action) {
    return false;
  }
  if (query.entityType && event.entityType !== query.entityType) {
    return false;
  }
  if (query.entityId && event.entityId !== query.entityId) {
    return false;
  }
  if (query.from && event.occurredAt < query.from) {
    return false;
  }
  if (query.to && event.occurredAt > query.to) {
    return false;
  }
  if (query.failuresOnly && !isFailureEvent(event)) {
    return false;
  }
  if (query.permissionDenialsOnly && !isPermissionDenial(event)) {
    return false;
  }
  return true;
}
