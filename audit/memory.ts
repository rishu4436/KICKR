import { newId } from "../shared/ids.js";
import { parseAuditEventInput } from "./validate.js";
import type { AuditEvent, AuditEventInput, AuditStore } from "./types.js";

/** Test double. Not authoritative. Production uses Postgres. */
export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];

  async append(input: AuditEventInput): Promise<AuditEvent> {
    const parsed = parseAuditEventInput(input);
    const event: AuditEvent = {
      ...parsed,
      metadata: { ...parsed.metadata },
      id: newId(),
      createdAt: parsed.occurredAt,
    };
    this.events.push(event);
    return event;
  }

  async list(limit: number): Promise<readonly AuditEvent[]> {
    return this.events.slice(0, limit).map((event) => ({
      ...event,
      metadata: { ...event.metadata },
    }));
  }
}
