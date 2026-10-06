import type { MatchState } from "../state-machine.js";

/**
 * Presentation buckets for the match list.
 * TODO: grouping POSTPONED with upcoming and LOCKED with live is a UI choice,
 * not a contest rule.
 */
export type MatchBucket = "upcoming" | "live" | "completed";

const UPCOMING = new Set(["SCHEDULED", "LINEUPS_AVAILABLE", "POSTPONED"]);
const LIVE = new Set(["LOCKED", "LIVE", "HALFTIME"]);

export function matchBucket(status: MatchState | string): MatchBucket {
  if (UPCOMING.has(status)) {
    return "upcoming";
  }
  if (LIVE.has(status)) {
    return "live";
  }
  return "completed";
}

/**
 * My Contests / result CTA lifecycle. Derived from the match (and optional final
 * result), not contest seat status. FULL before kickoff stays upcoming; LOCKED
 * contest is not automatically completed.
 *
 * Shared by API enrichment and the consumer UI.
 */
export type ContestLifecycleBucket = "upcoming" | "live" | "completed";
export type ContestPrimaryCta = "view_contest" | "live_leaderboard" | "view_result";

/** Pre-kickoff match states — XI may be open or locked, but play has not started. */
const CONTEST_PRE_KICKOFF = new Set([
  "SCHEDULED",
  "LINEUPS_AVAILABLE",
  "LOCKED",
  "POSTPONED",
]);

/** Match is actually being played. */
const CONTEST_IN_PROGRESS = new Set(["LIVE", "HALFTIME"]);

/** Match / result lifecycle finished (or abandoned). */
const CONTEST_FINALIZED = new Set([
  "FULL_TIME",
  "DATA_FINALIZING",
  "FINAL",
  "CANCELLED",
  "ABANDONED",
  "VOID",
]);

export function classifyContestLifecycle(input: {
  matchStatus: MatchState | string | null | undefined;
  hasFinalResult?: boolean;
}): ContestLifecycleBucket {
  if (input.hasFinalResult) {
    return "completed";
  }
  const status = input.matchStatus ?? "";
  if (CONTEST_IN_PROGRESS.has(status)) {
    return "live";
  }
  if (CONTEST_PRE_KICKOFF.has(status)) {
    return "upcoming";
  }
  if (CONTEST_FINALIZED.has(status)) {
    return "completed";
  }
  // Unknown match status: fail closed to completed rather than showing Join/Result wrongly.
  return "completed";
}

export function contestPrimaryCta(bucket: ContestLifecycleBucket): ContestPrimaryCta {
  if (bucket === "completed") {
    return "view_result";
  }
  if (bucket === "live") {
    return "live_leaderboard";
  }
  return "view_contest";
}

/**
 * XI can be built only before the match leaves the pre-kickoff open states
 * and only when an official squad is marked available.
 * TODO: the exact kickoff cutoff inside SCHEDULED is unspecified.
 */
export function canBuildXi(status: string, lineupAvailable: boolean): boolean {
  return lineupAvailable && (status === "SCHEDULED" || status === "LINEUPS_AVAILABLE");
}

/** Formation label derived only from selected role counts. Not a tactical catalog. */
export function formationLabel(positions: readonly string[]): string {
  const def = positions.filter((position) => position === "DEF").length;
  const mid = positions.filter((position) => position === "MID").length;
  const fwd = positions.filter((position) => position === "FWD").length;
  return `${def}-${mid}-${fwd}`;
}
