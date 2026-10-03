import { IllegalTransitionError } from "../shared/errors.js";

/**
 * Reusable transition guard. There is no setStatus and no raw status setter.
 * Callers must use transition(), which throws on an illegal edge.
 *
 * Contest lifecycle states are defined. Only the sequential path below is legal.
 * TODO: REFUNDED from-states are unspecified. REFUNDED is a known state and is
 *       not reachable. It is not allowed from every state, and it is not allowed
 *       from any state until product defines the edges.
 * TODO: Whether any contest edge may be reversed (for example IN_REVIEW back to
 *       LOCKED) is unspecified. No reverse edges are legal.
 * TODO: ACCOUNT states and transitions are unspecified.
 * TODO: TEAM states and transitions are unspecified.
 * TODO: MATCH states and transitions are unspecified.
 * TODO: ENTRY states and transitions are unspecified. INDEXER_CONFIRM_ENTRY is
 *       not a status write on this machine.
 * TODO: REVIEW states and transitions are unspecified.
 * TODO: SETTLEMENT states and transitions are unspecified.
 */

export const ENTITIES = [
  "ACCOUNT",
  "TEAM",
  "CONTEST",
  "MATCH",
  "ENTRY",
  "REVIEW",
  "SETTLEMENT",
] as const;

export type EntityName = (typeof ENTITIES)[number];

export const CONTEST_STATES = [
  "OPEN",
  "PENDING",
  "CONFIRMED",
  "LOCKED",
  "IN_REVIEW",
  "READY_FOR_SETTLEMENT",
  "SETTLED",
  "REFUNDED",
] as const;

export type ContestState = (typeof CONTEST_STATES)[number];

/** The only legal contest edges in Phase 1. */
export const CONTEST_TRANSITIONS: ReadonlyArray<readonly [ContestState, ContestState]> = [
  ["OPEN", "PENDING"],
  ["PENDING", "CONFIRMED"],
  ["CONFIRMED", "LOCKED"],
  ["LOCKED", "IN_REVIEW"],
  ["IN_REVIEW", "READY_FOR_SETTLEMENT"],
  ["READY_FOR_SETTLEMENT", "SETTLED"],
];

const TRANSITIONS: Record<EntityName, ReadonlyArray<readonly [string, string]>> = {
  ACCOUNT: [],
  TEAM: [],
  CONTEST: CONTEST_TRANSITIONS,
  MATCH: [],
  ENTRY: [],
  REVIEW: [],
  SETTLEMENT: [],
};

const ENTITY_SET: ReadonlySet<string> = new Set(ENTITIES);

export function isKnownEntity(entity: string): entity is EntityName {
  return ENTITY_SET.has(entity);
}

export function isTransitionLegal(entity: EntityName, from: string, to: string): boolean {
  if (!isKnownEntity(entity)) {
    return false;
  }
  return TRANSITIONS[entity].some(([legalFrom, legalTo]) => legalFrom === from && legalTo === to);
}

export function transition(entity: EntityName, from: string, to: string): string {
  if (!isTransitionLegal(entity, from, to)) {
    throw new IllegalTransitionError(entity, from, to);
  }
  return to;
}
