/**
 * Live leaderboard cache freshness.
 *
 * Postgres event log + contest entry set are the source of truth.
 * Redis cache must never outlive a newer scoring snapshot.
 * scoreSnapshotId is a deterministic etag over (events, entries).
 */

export interface ScoreSnapshotInput {
  eventCount: number;
  /** Max event timestamp ISO, or empty when no events. */
  lastEventAt: string | null;
  /** Stable, sorted entry ids that participate in scoring. */
  entryIds: readonly string[];
  /** Optional last event id for stronger identity when timestamps collide. */
  lastEventId?: string | null;
}

/** Deterministic score-snapshot etag. Safe as a Redis cache comparison key. */
export function computeScoreSnapshotId(input: ScoreSnapshotInput): string {
  const entries = [...input.entryIds].sort().join(",");
  const lastAt = input.lastEventAt ?? "";
  const lastId = input.lastEventId ?? "";
  return `v1:${input.eventCount}:${lastAt}:${lastId}:${entries.length}:${entries}`;
}

export function eventLogFingerprint(
  events: ReadonlyArray<{ eventId: string; timestamp: string }>,
): { eventCount: number; lastEventAt: string | null; lastEventId: string | null } {
  if (events.length === 0) {
    return { eventCount: 0, lastEventAt: null, lastEventId: null };
  }
  let last = events[0]!;
  for (const event of events) {
    if (
      event.timestamp > last.timestamp ||
      (event.timestamp === last.timestamp && event.eventId > last.eventId)
    ) {
      last = event;
    }
  }
  return {
    eventCount: events.length,
    lastEventAt: last.timestamp,
    lastEventId: last.eventId,
  };
}

/** True when cached snapshot is still valid vs current postgres fingerprint. */
export function isScoreSnapshotFresh(
  cachedSnapshotId: string | null | undefined,
  expectedSnapshotId: string,
): boolean {
  return Boolean(cachedSnapshotId) && cachedSnapshotId === expectedSnapshotId;
}
