/**
 * Adaptive Sportmonks poll intervals by match state.
 * INPLAY: 10s; HT/breaks: 30s; PREMATCH: lower frequency; FINAL: stop high-frequency.
 */

export const POLL_INTERVAL_MS = {
  INPLAY: 10_000,
  BREAK: 30_000,
  PREMATCH: 60_000,
  FINAL: null as number | null, // stop high-frequency polling
  DEFAULT: 30_000,
} as const;

/** Sportmonks state_id → polling class. */
export type PollClass = "INPLAY" | "BREAK" | "PREMATCH" | "FINAL" | "OTHER";

const INPLAY_STATES = new Set([2, 6, 9, 22, 23]); // 1st, ET, pens, 2nd, ET2
const BREAK_STATES = new Set([3, 4, 21, 25]); // HT, Break, ET break, pen break
const PREMATCH_STATES = new Set([1, 13, 26]); // NS, TBA, Pending
const FINAL_STATES = new Set([5, 7, 8, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20]); // FT and terminal

export function pollClassForStateId(stateId: number | null | undefined): PollClass {
  if (stateId === null || stateId === undefined || !Number.isFinite(stateId)) {
    return "OTHER";
  }
  if (INPLAY_STATES.has(stateId)) return "INPLAY";
  if (BREAK_STATES.has(stateId)) return "BREAK";
  if (PREMATCH_STATES.has(stateId)) return "PREMATCH";
  if (FINAL_STATES.has(stateId)) return "FINAL";
  return "OTHER";
}

/** Milliseconds until next poll, or null to stop high-frequency polling. */
export function pollIntervalMsForStateId(stateId: number | null | undefined): number | null {
  const cls = pollClassForStateId(stateId);
  switch (cls) {
    case "INPLAY":
      return POLL_INTERVAL_MS.INPLAY;
    case "BREAK":
      return POLL_INTERVAL_MS.BREAK;
    case "PREMATCH":
      return POLL_INTERVAL_MS.PREMATCH;
    case "FINAL":
      return POLL_INTERVAL_MS.FINAL;
    default:
      return POLL_INTERVAL_MS.DEFAULT;
  }
}

export function isProviderFinalState(stateId: unknown): boolean {
  return typeof stateId === "number" && FINAL_STATES.has(stateId);
}

export function isProviderInplayState(stateId: unknown): boolean {
  return typeof stateId === "number" && INPLAY_STATES.has(stateId);
}

export function mapSportmonksStateToMatchStatus(
  stateId: number | null | undefined,
): "SCHEDULED" | "LIVE" | "HALFTIME" | "FULL_TIME" | "POSTPONED" | "CANCELLED" {
  if (stateId === null || stateId === undefined) return "SCHEDULED";
  if (INPLAY_STATES.has(stateId)) return "LIVE";
  if (stateId === 3 || stateId === 4 || stateId === 21 || stateId === 25) return "HALFTIME";
  if (stateId === 10) return "POSTPONED";
  if (stateId === 12 || stateId === 15) return "CANCELLED";
  if (FINAL_STATES.has(stateId)) return "FULL_TIME";
  return "SCHEDULED";
}
