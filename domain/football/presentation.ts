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
