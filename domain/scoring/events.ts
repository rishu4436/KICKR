/** Canonical scoring event types. A production provider is not assumed. */
export const SCORING_EVENT_TYPES = [
  "GOAL",
  "ASSIST",
  "SHOT",
  "SHOT_ON_TARGET",
  "KEY_PASS",
  "TACKLE",
  "INTERCEPTION",
  "CLEARANCE",
  "SAVE",
  "CORNER_WON",
  "FOUL_COMMITTED",
  "YELLOW_CARD",
  "RED_CARD",
  "OWN_GOAL",
  "SUBSTITUTION",
  "PENALTY_MISS",
  "PENALTY_SAVE",
  "GOAL_CONCEDED",
  "VAR_REVERSAL",
] as const;

export type ScoringEventType = (typeof SCORING_EVENT_TYPES)[number];

export function isScoringEventType(value: string): value is ScoringEventType {
  return (SCORING_EVENT_TYPES as readonly string[]).includes(value);
}
