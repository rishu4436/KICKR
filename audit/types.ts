import type { AuditEventName } from "./events.js";

/**
 * Append-only audit record.
 * TODO: per-event metadata key schemas are unspecified. metadata must be a
 * JSON object; which keys each event requires is not defined, except that
 * the field itself is required.
 */
export interface AuditEventInput {
  action: AuditEventName;
  occurredAt: Date;
  entityType: string;
  entityId: string;
  metadata: Record<string, unknown>;
  actorAccountId: string | null;
  actorWallet: string | null;
  correlationId: string | null;
}

export interface AuditEvent extends AuditEventInput {
  id: string;
  createdAt: Date;
}

export interface AuditStore {
  append(input: AuditEventInput): Promise<AuditEvent>;
  list(limit: number): Promise<readonly AuditEvent[]>;
}
