import { IllegalTransitionError } from "../shared/errors.js";

/**
 * Reusable transition guard. There is no setStatus and no raw status setter.
 * Callers must use transition(), which throws on an illegal edge.
 *
 * Contest lifecycle states are defined. The Phase 1 path remains legal.
 * Phase 3 adds the instance path OPEN → PARTIALLY_FILLED → FULL → LOCKED →
 * IN_PROGRESS → IN_REVIEW → READY_FOR_SETTLEMENT → SETTLED, plus OPEN → LOCKED
 * so a match lock can close an empty joinable room. PENDING and CONFIRMED stay
 * on the Phase 1 path only. Phase 3 instances do not use them, and they do not
 * mean a seat was paid.
 * TODO: REFUNDED from-states are unspecified. REFUNDED is a known state and is
 *       not reachable. It is not allowed from every state, and it is not allowed
 *       from any state until product defines the edges. Phase 3 does not move
 *       a contest to REFUNDED or VOID, and neither edge would move USDC.
 * VOID inbound edges exist only as exceptional, non-financial closures. Phase 3
 * does not call them.
 * TODO: Whether any contest edge may be reversed (for example IN_REVIEW back to
 *       LOCKED) is unspecified. No reverse edges are legal.
 * TODO: ACCOUNT states and transitions are unspecified.
 * Fantasy TEAM states in Phase 2: DRAFT and LOCKED. The only legal edge is
 * DRAFT → LOCKED. TODO: kickoff does not auto-lock a team yet. TODO: whether
 * LOCKED can ever return to DRAFT is unspecified.
 * MATCH states and edges are defined below. TODO: whether POSTPONED can resume,
 * whether extra time exists, and whether HALFTIME may go straight to FULL_TIME,
 * are unspecified beyond the explicit edges. Contest REFUNDED is unchanged.
 * ENTRY states are PENDING, CONFIRMED, REFUNDED, CANCELLED. The only legal
 * edge in Phase 3 is PENDING → CANCELLED. PENDING → CONFIRMED is intentionally
 * absent: Phase 4 may add it only after on-chain verification. INDEXER_CONFIRM_ENTRY
 * is not a status write on this machine. Phase 3 join does not confirm an entry.
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
  "PARTIALLY_FILLED",
  "FULL",
  "PENDING",
  "CONFIRMED",
  "LOCKED",
  "IN_PROGRESS",
  "IN_REVIEW",
  "READY_FOR_SETTLEMENT",
  "SETTLED",
  "REFUNDED",
  "VOID",
] as const;

export type ContestState = (typeof CONTEST_STATES)[number];

/**
 * Phase 1 path plus Phase 3 instance edges.
 * OPEN → LOCKED is the match-lock edge for a still-joinable room.
 * REFUNDED has no inbound edge. VOID edges are exceptional and not financial;
 * Phase 3 does not transition to VOID or REFUNDED.
 */
export const CONTEST_TRANSITIONS: ReadonlyArray<readonly [ContestState, ContestState]> = [
  ["OPEN", "PENDING"],
  ["PENDING", "CONFIRMED"],
  ["CONFIRMED", "LOCKED"],
  ["LOCKED", "IN_REVIEW"],
  ["IN_REVIEW", "READY_FOR_SETTLEMENT"],
  ["READY_FOR_SETTLEMENT", "SETTLED"],
  ["OPEN", "PARTIALLY_FILLED"],
  ["PARTIALLY_FILLED", "FULL"],
  ["PARTIALLY_FILLED", "LOCKED"],
  ["FULL", "LOCKED"],
  ["OPEN", "LOCKED"],
  ["LOCKED", "IN_PROGRESS"],
  ["IN_PROGRESS", "IN_REVIEW"],
  ["OPEN", "VOID"],
  ["PARTIALLY_FILLED", "VOID"],
  ["FULL", "VOID"],
];

export const TEAM_STATES = ["DRAFT", "LOCKED"] as const;
export type TeamState = (typeof TEAM_STATES)[number];

/** Fantasy team. History is not a status write; versions are append-only. */
export const TEAM_TRANSITIONS: ReadonlyArray<readonly [TeamState, TeamState]> = [["DRAFT", "LOCKED"]];

export const MATCH_STATES = [
  "SCHEDULED",
  "LINEUPS_AVAILABLE",
  "LOCKED",
  "LIVE",
  "HALFTIME",
  "FULL_TIME",
  "DATA_FINALIZING",
  "FINAL",
  "POSTPONED",
  "CANCELLED",
  "ABANDONED",
  "VOID",
] as const;

export type MatchState = (typeof MATCH_STATES)[number];

/**
 * Normal path plus the explicit exceptional edges.
 * FULL_TIME → DATA_FINALIZING is both the normal path and an explicit edge.
 * HALFTIME → LIVE is allowed so the second half can restart LIVE.
 */
export const MATCH_TRANSITIONS: ReadonlyArray<readonly [MatchState, MatchState]> = [
  ["SCHEDULED", "LINEUPS_AVAILABLE"],
  ["LINEUPS_AVAILABLE", "LOCKED"],
  ["LOCKED", "LIVE"],
  ["LIVE", "HALFTIME"],
  ["HALFTIME", "LIVE"],
  ["LIVE", "FULL_TIME"],
  ["FULL_TIME", "DATA_FINALIZING"],
  ["DATA_FINALIZING", "FINAL"],
  ["SCHEDULED", "POSTPONED"],
  ["SCHEDULED", "CANCELLED"],
  ["LIVE", "ABANDONED"],
  ["DATA_FINALIZING", "VOID"],
];


export const ENTRY_STATES = ["PENDING", "CONFIRMED", "REFUNDED", "CANCELLED"] as const;
export type EntryState = (typeof ENTRY_STATES)[number];

/**
 * PENDING → CONFIRMED is legal only for the Phase 4 indexer after a
 * finalized deposit matches the reservation. Join must not call it.
 * REFUNDED stays unreachable. No refund instruction moves USDC in Phase 4.
 */
export const ENTRY_TRANSITIONS: ReadonlyArray<readonly [EntryState, EntryState]> = [
  ["PENDING", "CANCELLED"],
  ["PENDING", "CONFIRMED"],
];

const TRANSITIONS: Record<EntityName, ReadonlyArray<readonly [string, string]>> = {
  ACCOUNT: [],
  TEAM: TEAM_TRANSITIONS,
  CONTEST: CONTEST_TRANSITIONS,
  MATCH: MATCH_TRANSITIONS,
  ENTRY: ENTRY_TRANSITIONS,
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
