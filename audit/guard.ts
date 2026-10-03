import { AppError } from "../shared/errors.js";

/**
 * Application-level rejection of audit mutation.
 * There is no update or delete implementation. These functions exist so a
 * caller cannot reach a status-style setter, and so tests can observe the refusal.
 * The database also rejects UPDATE and DELETE with a trigger.
 */
export function updateAuditEvent(): never {
  throw new AppError("AUDIT_APPEND_ONLY", 405, "UPDATE of audit_events is forbidden");
}

export function deleteAuditEvent(): never {
  throw new AppError("AUDIT_APPEND_ONLY", 405, "DELETE of audit_events is forbidden");
}
