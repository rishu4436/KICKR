import { SCORING_EVENT_TYPES, type ScoringEventType } from "./events.js";

/**
 * DEV_V1 is a development ruleset for tests and local replay.
 * It is not the production scoring contract.
 *
 * Scale: milli-points. 1000 milli-points = 1 displayed point.
 * Weights are integers. Captain is 2/1. Vice is 3/2.
 * Rounding: integer division toward zero after the multiplier, applied once
 * to a player's summed base milli-points.
 * TODO: primary_player_id is the only scored player. Whether the secondary
 * player also scores is unspecified.
 */
export const DEV_V1_SCALE = 1000;

export const DEV_V1_WEIGHTS: Record<ScoringEventType, number> = {
  GOAL: 5 * DEV_V1_SCALE,
  ASSIST: 3 * DEV_V1_SCALE,
  SHOT: 0,
  SHOT_ON_TARGET: 1 * DEV_V1_SCALE,
  KEY_PASS: 0,
  TACKLE: 0,
  INTERCEPTION: 0,
  CLEARANCE: 0,
  SAVE: 0,
  CORNER_WON: 1 * DEV_V1_SCALE,
  FOUL_COMMITTED: 0,
  YELLOW_CARD: -1 * DEV_V1_SCALE,
  RED_CARD: 0,
  OWN_GOAL: 0,
  SUBSTITUTION: 0,
  PENALTY_MISS: 0,
  PENALTY_SAVE: 0,
  GOAL_CONCEDED: 0,
  VAR_REVERSAL: 0,
};

export interface Multiplier {
  numerator: number;
  denominator: number;
}

export interface ScoringRuleset {
  rulesetId: string;
  version: number;
  name: string;
  effectiveFrom: string;
  eventWeights: Record<ScoringEventType, number>;
  captainMultiplier: Multiplier;
  viceMultiplier: Multiplier;
  roundingPolicy: "TOWARD_ZERO";
  scale: number;
  status: "DEVELOPMENT";
}

export const DEV_V1_RULESET: ScoringRuleset = {
  rulesetId: "40000000-0000-4000-8000-000000000001",
  version: 1,
  name: "DEV_V1",
  effectiveFrom: "2026-01-01T00:00:00.000Z",
  eventWeights: DEV_V1_WEIGHTS,
  captainMultiplier: { numerator: 2, denominator: 1 },
  viceMultiplier: { numerator: 3, denominator: 2 },
  roundingPolicy: "TOWARD_ZERO",
  scale: DEV_V1_SCALE,
  status: "DEVELOPMENT",
};

export function assertDevV1Complete(): void {
  for (const eventType of SCORING_EVENT_TYPES) {
    const weight = DEV_V1_WEIGHTS[eventType];
    if (!Number.isInteger(weight)) {
      throw new Error(`DEV_V1 weight for ${eventType} is not an integer`);
    }
  }
}
