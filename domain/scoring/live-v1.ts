import { SCORING_EVENT_TYPES, type ScoringEventType } from "./events.js";
import type { ScoringRuleset } from "./dev-v1.js";
import { DEV_V1_SCALE } from "./dev-v1.js";

/**
 * LIVE_V1 — production-demo Sportmonks live ruleset (Phase 18C).
 * Does not mutate historical DEV_V1.
 *
 * KEEP: GOAL +5, ASSIST +3, SHOT_ON_TARGET +1, YELLOW_CARD -1
 * REMOVE: CORNER_WON (weight 0; was +1 in DEV_V1)
 * Captain 2x, Vice 1.5x (3/2). Milli-points scale 1000.
 */
export const LIVE_V1_SCALE = DEV_V1_SCALE;

export const LIVE_V1_WEIGHTS: Record<ScoringEventType, number> = {
  GOAL: 5 * LIVE_V1_SCALE,
  ASSIST: 3 * LIVE_V1_SCALE,
  SHOT: 0,
  SHOT_ON_TARGET: 1 * LIVE_V1_SCALE,
  KEY_PASS: 0,
  TACKLE: 0,
  INTERCEPTION: 0,
  CLEARANCE: 0,
  SAVE: 0,
  CORNER_WON: 0,
  FOUL_COMMITTED: 0,
  YELLOW_CARD: -1 * LIVE_V1_SCALE,
  RED_CARD: 0,
  OWN_GOAL: 0,
  SUBSTITUTION: 0,
  PENALTY_MISS: 0,
  PENALTY_SAVE: 0,
  GOAL_CONCEDED: 0,
  VAR_REVERSAL: 0,
};

export const LIVE_V1_RULESET: ScoringRuleset = {
  rulesetId: "40000000-0000-4000-8000-000000000002",
  version: 2,
  name: "LIVE_V1",
  effectiveFrom: "2026-10-01T00:00:00.000Z",
  eventWeights: LIVE_V1_WEIGHTS,
  captainMultiplier: { numerator: 2, denominator: 1 },
  viceMultiplier: { numerator: 3, denominator: 2 },
  roundingPolicy: "TOWARD_ZERO",
  scale: LIVE_V1_SCALE,
  status: "DEVELOPMENT",
};

export function assertLiveV1Complete(): void {
  for (const eventType of SCORING_EVENT_TYPES) {
    const weight = LIVE_V1_WEIGHTS[eventType];
    if (!Number.isInteger(weight)) {
      throw new Error(`LIVE_V1 weight for ${eventType} is not an integer`);
    }
  }
  if (LIVE_V1_WEIGHTS.CORNER_WON !== 0) {
    throw new Error("LIVE_V1 must remove CORNER_WON scoring (weight 0)");
  }
}
