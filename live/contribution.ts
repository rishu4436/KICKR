import { applyMultiplier, type ScoringEventInput } from "../domain/scoring/engine.js";
import { DEV_V1_RULESET, DEV_V1_SCALE, type Multiplier } from "../domain/scoring/dev-v1.js";
import type { ScoringEventType } from "../domain/scoring/events.js";
import { calculatePlayerPoints, calculateTeamPoints, effectiveEvents } from "../domain/scoring/engine.js";

export type ScoreRole = "captain" | "vice" | "player";

export interface EventContributionExplanation {
  event: ScoringEventType;
  playerId: string | null;
  baseMilliPoints: number;
  basePoints: number;
  multiplier: Multiplier | null;
  multiplierLabel: string | null;
  contributionMilliPoints: number;
  contribution: number;
  previousPlayerTotalMilliPoints: number;
  newPlayerTotalMilliPoints: number;
  previousPlayerTotal: number;
  newPlayerTotal: number;
  previousTeamTotalMilliPoints: number;
  newTeamTotalMilliPoints: number;
  previousTeamTotal: number;
  newTeamTotal: number;
}

function roleFor(
  playerId: string,
  captainId: string,
  viceId: string,
): ScoreRole {
  if (playerId === captainId) {
    return "captain";
  }
  if (playerId === viceId) {
    return "vice";
  }
  return "player";
}

function multiplierFor(role: ScoreRole): Multiplier | null {
  if (role === "captain") {
    return DEV_V1_RULESET.captainMultiplier;
  }
  if (role === "vice") {
    return DEV_V1_RULESET.viceMultiplier;
  }
  return null;
}

function labelFor(role: ScoreRole): string | null {
  if (role === "captain") {
    return "captain 2/1";
  }
  if (role === "vice") {
    return "vice 3/2";
  }
  return null;
}

/**
 * Event contribution = event base weight × role multiplier (once).
 * Never treats the player's accumulated total as the contribution of one event.
 */
export function explainEventContribution(input: {
  eventsBefore: readonly ScoringEventInput[];
  eventsAfter: readonly ScoringEventInput[];
  trigger: ScoringEventInput;
  playerIds: readonly string[];
  captainId: string;
  viceId: string;
  matchContext: { matchId: string; homeClubId: string; awayClubId: string };
}): EventContributionExplanation {
  const playerId = input.trigger.primaryPlayerId;
  const role = playerId ? roleFor(playerId, input.captainId, input.viceId) : "player";
  const multiplier = multiplierFor(role);
  const baseMilliPoints = DEV_V1_RULESET.eventWeights[input.trigger.eventType] ?? 0;
  // Effective contribution of this event alone: if the trigger is superseded in
  // eventsAfter (e.g. a later correction), contribution is 0. If trigger itself
  // is a correction that supersedes another event, contribution is the delta
  // of that correction's own weight under the role multiplier (usually 0 for VAR).
  const triggerEffective = effectiveEvents(input.eventsAfter).some(
    (event) => event.eventId === input.trigger.eventId,
  );
  const rawContribution = triggerEffective ? baseMilliPoints : 0;
  const contributionMilliPoints = multiplier
    ? applyMultiplier(rawContribution, multiplier)
    : rawContribution;

  const previousPlayerTotalMilliPoints = playerId
    ? calculatePlayerPoints(input.eventsBefore, playerId, DEV_V1_RULESET, input.matchContext, role)
    : 0;
  const newPlayerTotalMilliPoints = playerId
    ? calculatePlayerPoints(input.eventsAfter, playerId, DEV_V1_RULESET, input.matchContext, role)
    : 0;
  const previousTeam = calculateTeamPoints(
    input.eventsBefore,
    { playerIds: input.playerIds, captainId: input.captainId, viceId: input.viceId },
    DEV_V1_RULESET,
    input.matchContext,
  );
  const newTeam = calculateTeamPoints(
    input.eventsAfter,
    { playerIds: input.playerIds, captainId: input.captainId, viceId: input.viceId },
    DEV_V1_RULESET,
    input.matchContext,
  );

  return {
    event: input.trigger.eventType,
    playerId,
    baseMilliPoints,
    basePoints: baseMilliPoints / DEV_V1_SCALE,
    multiplier,
    multiplierLabel: labelFor(role),
    contributionMilliPoints,
    contribution: contributionMilliPoints / DEV_V1_SCALE,
    previousPlayerTotalMilliPoints,
    newPlayerTotalMilliPoints,
    previousPlayerTotal: previousPlayerTotalMilliPoints / DEV_V1_SCALE,
    newPlayerTotal: newPlayerTotalMilliPoints / DEV_V1_SCALE,
    previousTeamTotalMilliPoints: previousTeam.milliPoints,
    newTeamTotalMilliPoints: newTeam.milliPoints,
    previousTeamTotal: previousTeam.milliPoints / DEV_V1_SCALE,
    newTeamTotal: newTeam.milliPoints / DEV_V1_SCALE,
  };
}
