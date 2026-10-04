import type { PlayerRole } from "../domain/football/roles.js";
import type { ScoringEventType } from "../domain/scoring/events.js";

/**
 * Derived on-pitch status from starting XI + SUBSTITUTION events.
 * Does not mutate squad enums (STARTER/BENCH stay as sourced).
 */

export type DerivedPitchStatus =
  | "STARTING"
  | "SUBSTITUTE"
  | "UNAVAILABLE"
  | "SUBSTITUTED_ON"
  | "SUBSTITUTED_OFF"
  | "UNKNOWN";

export interface LineupSeed {
  playerId: string;
  clubId: string;
  position: PlayerRole;
  startingStatus: "STARTER" | "BENCH" | "UNKNOWN";
  availability: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  squadStatus: "INCLUDED" | "EXCLUDED";
}

export interface SubEventLike {
  eventType: ScoringEventType;
  primaryPlayerId: string | null;
  secondaryPlayerId: string | null;
  sequence: number;
  matchMinute: number | null;
}

export interface PlayerPitchState {
  playerId: string;
  clubId: string;
  position: PlayerRole;
  derivedStatus: DerivedPitchStatus;
  onPitch: boolean;
}

export function mapStartingToDerived(
  startingStatus: LineupSeed["startingStatus"],
  availability: LineupSeed["availability"],
): DerivedPitchStatus {
  if (availability === "UNAVAILABLE") {
    return "UNAVAILABLE";
  }
  if (startingStatus === "STARTER") {
    return "STARTING";
  }
  if (startingStatus === "BENCH") {
    return "SUBSTITUTE";
  }
  return "UNKNOWN";
}

/** Replay substitutions in sequence order. primary=off, secondary=on. */
export function derivePitchStates(
  seeds: readonly LineupSeed[],
  substitutions: readonly SubEventLike[],
  atSequenceInclusive?: number,
): Map<string, PlayerPitchState> {
  const states = new Map<string, PlayerPitchState>();
  for (const seed of seeds) {
    if (seed.squadStatus === "EXCLUDED") {
      continue;
    }
    const derived = mapStartingToDerived(seed.startingStatus, seed.availability);
    states.set(seed.playerId, {
      playerId: seed.playerId,
      clubId: seed.clubId,
      position: seed.position,
      derivedStatus: derived,
      onPitch: derived === "STARTING",
    });
  }

  const ordered = substitutions
    .filter((event) => event.eventType === "SUBSTITUTION")
    .filter((event) => atSequenceInclusive === undefined || event.sequence <= atSequenceInclusive)
    .slice()
    .sort((a, b) => a.sequence - b.sequence);

  for (const event of ordered) {
    if (event.primaryPlayerId) {
      const off = states.get(event.primaryPlayerId);
      if (off) {
        off.derivedStatus = "SUBSTITUTED_OFF";
        off.onPitch = false;
      }
    }
    if (event.secondaryPlayerId) {
      const on = states.get(event.secondaryPlayerId);
      if (on) {
        on.derivedStatus = "SUBSTITUTED_ON";
        on.onPitch = true;
      }
    }
  }
  return states;
}

export interface GoalConcededEligibility {
  eligiblePlayerIds: string[];
  unresolved: boolean;
  reason: string | null;
}

/**
 * Who would be charged for GOAL_CONCEDED:
 * only GK/DEF actually on the pitch for the conceding club.
 * Does not invent a non-zero DEV_V1 weight.
 */
export function eligibleForGoalConceded(
  pitch: Map<string, PlayerPitchState>,
  concedingClubId: string | null,
): GoalConcededEligibility {
  if (!concedingClubId) {
    return {
      eligiblePlayerIds: [],
      unresolved: true,
      reason: "conceding club unknown",
    };
  }
  const known = [...pitch.values()].filter((row) => row.clubId === concedingClubId);
  if (known.length === 0) {
    return {
      eligiblePlayerIds: [],
      unresolved: true,
      reason: "no lineup pitch state for conceding club",
    };
  }
  if (known.some((row) => row.derivedStatus === "UNKNOWN")) {
    return {
      eligiblePlayerIds: [],
      unresolved: true,
      reason: "on-pitch status unknown for one or more squad players",
    };
  }
  const eligible = known
    .filter((row) => row.onPitch && (row.position === "GK" || row.position === "DEF"))
    .map((row) => row.playerId)
    .sort();
  return { eligiblePlayerIds: eligible, unresolved: false, reason: null };
}
