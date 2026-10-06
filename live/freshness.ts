import type { MatchState } from "../domain/state-machine.js";
import type { LiveFreshness } from "./cache.js";

/**
 * Freshness reflects provider/ingest health, not how long ago kickoff was.
 * A live match with a recent successful poll is LIVE even if kickoff was hours ago.
 *
 * Semantics (Phase 13):
 * - LIVE: freshness known and current
 * - STALE: freshness known and outside the threshold
 * - UNKNOWN: no provider poll / freshness data available (never treat as STALE)
 * - FINAL / DATA_ERROR: terminal / error paths
 */
export interface FreshnessInput {
  matchStatus: MatchState;
  now: Date;
  /** Wall-clock time of the last successful provider poll for this process/match. */
  lastSuccessfulPollAt: string | null;
  /** Optional ingest lag from the last poll (ms). */
  ingestionLagMs: number | null;
  staleAfterMs?: number;
}

export function computeFreshness(input: FreshnessInput): LiveFreshness {
  const staleAfterMs = input.staleAfterMs ?? 120_000;
  if (input.matchStatus === "FINAL" || input.matchStatus === "DATA_FINALIZING") {
    return "FINAL";
  }
  if (
    input.matchStatus === "LIVE" ||
    input.matchStatus === "HALFTIME" ||
    input.matchStatus === "FULL_TIME"
  ) {
    if (!input.lastSuccessfulPollAt) {
      // No Sportmonks / provider poll data — not the same as a known-stale feed.
      return "UNKNOWN";
    }
    const age = input.now.getTime() - Date.parse(input.lastSuccessfulPollAt);
    if (!Number.isFinite(age) || age > staleAfterMs) {
      return "STALE";
    }
    if (input.ingestionLagMs !== null && input.ingestionLagMs > staleAfterMs) {
      return "STALE";
    }
    return "LIVE";
  }
  return "LIVE";
}

/**
 * Deterministic occurrence timestamp when the provider does not supply one.
 * Documented fallback: fixture kickoff + match minute (+ extra minute).
 * This is NOT an exact wall-clock event time.
 */
export function occurrenceFromKickoffMinute(
  kickoffAt: string,
  matchMinute: number | null,
  extraMinute: number | null = null,
): { timestamp: string; timestampSource: "kickoff_plus_minute" } {
  const kickoffMs = Date.parse(kickoffAt);
  const minute = matchMinute ?? 0;
  const extra = extraMinute ?? 0;
  const ms = (Number.isFinite(kickoffMs) ? kickoffMs : 0) + (minute + extra) * 60_000;
  return {
    timestamp: new Date(ms).toISOString(),
    timestampSource: "kickoff_plus_minute",
  };
}

/** UI / API label for freshness chips. Never maps UNKNOWN → STALE. */
export function freshnessLabel(freshness: LiveFreshness | string | null | undefined): string {
  if (!freshness) return "";
  if (freshness === "UNKNOWN") return "FRESHNESS UNKNOWN";
  return freshness;
}
