import { z } from "zod";
import { AppError } from "../shared/errors.js";
import { AUDIT_EVENTS } from "./events.js";
import type { AuditEventInput } from "./types.js";

const metadataSchema = z.record(z.string(), z.unknown()).refine(
  (value) => !Array.isArray(value),
  "metadata must be an object",
);

export const auditEventInputSchema = z.object({
  action: z.enum(AUDIT_EVENTS),
  occurredAt: z.date(),
  entityType: z.string().min(1).max(64),
  entityId: z.string().min(1).max(128),
  metadata: metadataSchema,
  actorAccountId: z.string().uuid().nullable(),
  actorWallet: z.string().min(1).max(64).nullable(),
  correlationId: z.string().min(1).max(128).nullable(),
});

export function parseAuditEventInput(input: AuditEventInput): AuditEventInput {
  const parsed = auditEventInputSchema.safeParse(input);
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "event");
    throw new AppError("VALIDATION", 400, "Audit event is missing required fields", {
      fields,
    });
  }
  return parsed.data;
}
