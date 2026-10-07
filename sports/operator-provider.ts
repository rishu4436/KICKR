/**
 * Operator-managed fixture provenance (Phase 18D.2).
 * Never claim these rows came from Sportmonks. Separate from Tutorial (SIMULATED / demo).
 */

export const OPERATOR_PROVIDER_NAME = "operator" as const;

export const OPERATOR_PROVENANCE = "OPERATOR_MANAGED" as const;

export const EVENT_PROVENANCE = {
  MANUAL_OPERATOR: "MANUAL_OPERATOR",
  GROK_PROPOSED_MANUAL_CONFIRMED: "GROK_PROPOSED_MANUAL_CONFIRMED",
  SPORTMONKS: "SPORTMONKS",
} as const;

export type EventProvenance = (typeof EVENT_PROVENANCE)[keyof typeof EVENT_PROVENANCE];

export const OPERATOR_EVENT_TYPES = [
  "GOAL",
  "ASSIST",
  "SHOT_ON_TARGET",
  "YELLOW_CARD",
  "RED_CARD",
  "OWN_GOAL",
  "PENALTY_MISS",
  "PENALTY_SAVE",
  "SUBSTITUTION",
  "VAR_REVERSAL",
] as const;

export type OperatorEventType = (typeof OPERATOR_EVENT_TYPES)[number];

export function isOperatorEventType(value: string): value is OperatorEventType {
  return (OPERATOR_EVENT_TYPES as readonly string[]).includes(value);
}

/** Inclusive credit range for operator edits. */
export const OPERATOR_CREDIT_MIN = 1;
export const OPERATOR_CREDIT_MAX = 20;

export function operatorMatchLabel(): string {
  return "OPERATOR_MANAGED — manual match operations (not Sportmonks, not Tutorial)";
}

export function isOperatorManagedDataSource(dataSource: {
  provider: string;
  provenance?: string;
}): boolean {
  return (
    dataSource.provider === OPERATOR_PROVIDER_NAME ||
    dataSource.provenance === OPERATOR_PROVENANCE
  );
}

export function isSportmonksDataSource(provider: string): boolean {
  return provider.trim().toLowerCase().replace(/_/g, "-") === "sportmonks";
}

export function isTutorialDemoDataSource(provider: string): boolean {
  return provider.trim().toLowerCase().replace(/_/g, "-") === "demo";
}
