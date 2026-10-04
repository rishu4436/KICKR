import { SCORING_EVENT_TYPES, type ScoringEventType } from "./events.js";
import type { Multiplier, ScoringRuleset } from "./dev-v1.js";

export interface ScoringEventInput {
  eventId: string;
  eventType: ScoringEventType;
  primaryPlayerId: string | null;
  secondaryPlayerId: string | null;
  supersedesEventId: string | null;
  sequence: number;
}

export interface ScoredTeamVersion {
  playerIds: readonly string[];
  captainId: string;
  viceId: string;
}

export interface MatchScoringContext {
  matchId: string;
  homeClubId: string;
  awayClubId: string;
}

export interface PlayerScore {
  playerId: string;
  baseMilliPoints: number;
  milliPoints: number;
}

export interface TeamScore {
  milliPoints: number;
  scale: number;
  players: PlayerScore[];
}

/**
 * Drop events that have been superseded. The original row is not modified.
 * A correction is a later event with supersedesEventId set.
 */
export function effectiveEvents(events: readonly ScoringEventInput[]): ScoringEventInput[] {
  const superseded = new Set<string>();
  for (const event of events) {
    if (event.supersedesEventId) {
      superseded.add(event.supersedesEventId);
    }
  }
  return events
    .filter((event) => !superseded.has(event.eventId))
    .slice()
    .sort((a, b) => a.sequence - b.sequence || a.eventId.localeCompare(b.eventId));
}

function weightFor(ruleset: ScoringRuleset, eventType: ScoringEventType): number {
  const weight = ruleset.eventWeights[eventType];
  if (!Number.isInteger(weight)) {
    throw new Error(`ruleset ${ruleset.name} is missing an integer weight for ${eventType}`);
  }
  return weight;
}

/** Integer division toward zero. No floating point. */
export function applyMultiplier(milliPoints: number, multiplier: Multiplier): number {
  if (!Number.isInteger(milliPoints) || !Number.isInteger(multiplier.numerator) || !Number.isInteger(multiplier.denominator)) {
    throw new Error("scoring math requires integers");
  }
  if (multiplier.denominator === 0) {
    throw new Error("multiplier denominator must not be 0");
  }
  return Number((BigInt(milliPoints) * BigInt(multiplier.numerator)) / BigInt(multiplier.denominator));
}

export function calculatePlayerPoints(
  events: readonly ScoringEventInput[],
  playerId: string,
  ruleset: ScoringRuleset,
  matchContext: MatchScoringContext,
  role: "captain" | "vice" | "player" = "player",
): number {
  if (!matchContext.matchId) {
    throw new Error("match context is required");
  }
  for (const eventType of SCORING_EVENT_TYPES) {
    weightFor(ruleset, eventType);
  }
  let base = 0;
  for (const event of effectiveEvents(events)) {
    if (event.primaryPlayerId !== playerId) {
      continue;
    }
    base += weightFor(ruleset, event.eventType);
  }
  if (role === "captain") {
    return applyMultiplier(base, ruleset.captainMultiplier);
  }
  if (role === "vice") {
    return applyMultiplier(base, ruleset.viceMultiplier);
  }
  return base;
}

export function calculateTeamPoints(
  events: readonly ScoringEventInput[],
  fantasyTeamVersion: ScoredTeamVersion,
  ruleset: ScoringRuleset,
  matchContext: MatchScoringContext,
): TeamScore {
  const players: PlayerScore[] = [];
  let total = 0;
  for (const playerId of fantasyTeamVersion.playerIds) {
    const role =
      playerId === fantasyTeamVersion.captainId
        ? "captain"
        : playerId === fantasyTeamVersion.viceId
          ? "vice"
          : "player";
    const baseMilliPoints = calculatePlayerPoints(events, playerId, ruleset, matchContext, "player");
    const milliPoints = calculatePlayerPoints(events, playerId, ruleset, matchContext, role);
    players.push({ playerId, baseMilliPoints, milliPoints });
    total += milliPoints;
  }
  return { milliPoints: total, scale: ruleset.scale, players };
}
