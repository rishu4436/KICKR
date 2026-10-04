import { createHash } from "node:crypto";
import { isScoringEventType, type ScoringEventType } from "../domain/scoring/events.js";

/**
 * Canonical normalization for provider football events.
 * Sportmonks Football API v3 type_ids are the primary production mapping.
 * Unsupported-but-valid provider events become canonical types with weight 0
 * or metadata.unknownProviderType when no mapping exists.
 */

export const SPORTMONKS_API_VERSION = "v3";

/** Sportmonks event type_id → KICKR ScoringEventType. */
export const SPORTMONKS_EVENT_TYPE_MAP: Record<number, ScoringEventType> = {
  10: "VAR_REVERSAL",
  14: "GOAL",
  15: "OWN_GOAL",
  16: "GOAL", // penalty scored
  17: "PENALTY_MISS",
  18: "SUBSTITUTION",
  19: "YELLOW_CARD",
  20: "RED_CARD",
  21: "RED_CARD", // second yellow
  126: "CORNER_WON",
  569: "SHOT_ON_TARGET",
  570: "SHOT",
  1697: "VAR_REVERSAL",
};

/** Sub-type overrides (Sportmonks). */
export const SPORTMONKS_SUBTYPE_MAP: Record<number, ScoringEventType> = {
  1509: "PENALTY_SAVE",
  1512: "VAR_REVERSAL", // Goal Disallowed
};

export interface RawProviderEvent {
  provider: string;
  providerEventId: string;
  externalFixtureId: string;
  typeCode: string | number;
  subTypeCode?: string | number | null;
  minute?: number | null;
  extraMinute?: number | null;
  period?: string | number | null;
  sortOrder?: number | null;
  occurredAt?: string | null;
  primaryExternalPlayerId?: string | number | null;
  secondaryExternalPlayerId?: string | number | null;
  externalTeamId?: string | number | null;
  playerName?: string | null;
  relatedPlayerName?: string | null;
  info?: string | null;
  addition?: string | null;
  result?: string | null;
  raw: Record<string, unknown>;
}

export interface NormalizedEventDraft {
  provider: string;
  providerEventId: string;
  externalFixtureId: string;
  sequence: number;
  timestamp: string;
  matchMinute: number | null;
  period: string | null;
  eventType: ScoringEventType;
  primaryExternalPlayerId: string | null;
  secondaryExternalPlayerId: string | null;
  externalTeamId: string | null;
  correctionType: "VAR_REVERSAL" | "PROVIDER_CORRECTION" | "SUPERSEDE" | null;
  providerVersion: string | null;
  rawEventHash: string;
  metadata: Record<string, unknown>;
  /** When true, primary player mapping is required for scoring attribution. */
  requiresPrimaryPlayer: boolean;
  /** Assist companion for goals that carry related_player_id. */
  derivedAssist?: {
    providerEventId: string;
    primaryExternalPlayerId: string;
  };
}

export function hashRawEvent(raw: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(raw), "utf8").digest("hex");
}

function asExternalId(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return String(value);
}

function mapSportmonksType(typeId: number, subTypeId: number | null): {
  eventType: ScoringEventType;
  unknown: boolean;
  correctionType: NormalizedEventDraft["correctionType"];
} {
  if (subTypeId !== null && SPORTMONKS_SUBTYPE_MAP[subTypeId]) {
    const mapped = SPORTMONKS_SUBTYPE_MAP[subTypeId];
    return {
      eventType: mapped,
      unknown: false,
      correctionType: mapped === "VAR_REVERSAL" ? "VAR_REVERSAL" : null,
    };
  }
  const mapped = SPORTMONKS_EVENT_TYPE_MAP[typeId];
  if (mapped) {
    return {
      eventType: mapped,
      unknown: false,
      correctionType: mapped === "VAR_REVERSAL" ? "VAR_REVERSAL" : null,
    };
  }
  // Store as SHOT with weight 0 path via unknown metadata; prefer a zero-weight type.
  return { eventType: "SHOT", unknown: true, correctionType: null };
}

/**
 * Normalize one Sportmonks event or timeline row into a canonical draft.
 * Assists are derived from goal related_player_id (Sportmonks has no assist type_id).
 */
export function normalizeSportmonksEvent(
  raw: RawProviderEvent,
  sequence: number,
  providerVersion: string | null = SPORTMONKS_API_VERSION,
): NormalizedEventDraft {
  const typeId = typeof raw.typeCode === "number" ? raw.typeCode : Number(raw.typeCode);
  const subTypeId =
    raw.subTypeCode === null || raw.subTypeCode === undefined || raw.subTypeCode === ""
      ? null
      : typeof raw.subTypeCode === "number"
        ? raw.subTypeCode
        : Number(raw.subTypeCode);
  const mapped = mapSportmonksType(
    Number.isFinite(typeId) ? typeId : -1,
    subTypeId !== null && Number.isFinite(subTypeId) ? subTypeId : null,
  );
  const primaryExternalPlayerId = asExternalId(raw.primaryExternalPlayerId);
  const secondaryExternalPlayerId = asExternalId(raw.secondaryExternalPlayerId);
  const minute = raw.minute ?? null;
  const timestamp =
    raw.occurredAt && !Number.isNaN(Date.parse(raw.occurredAt))
      ? new Date(raw.occurredAt).toISOString()
      : new Date(0).toISOString();

  const draft: NormalizedEventDraft = {
    provider: "sportmonks",
    providerEventId: String(raw.providerEventId),
    externalFixtureId: String(raw.externalFixtureId),
    sequence,
    timestamp,
    matchMinute: minute,
    period: raw.period === null || raw.period === undefined ? null : String(raw.period),
    eventType: mapped.eventType,
    primaryExternalPlayerId,
    secondaryExternalPlayerId,
    externalTeamId: asExternalId(raw.externalTeamId),
    correctionType: mapped.correctionType,
    providerVersion,
    rawEventHash: hashRawEvent(raw.raw),
    metadata: {
      providerTypeId: typeId,
      providerSubTypeId: subTypeId,
      playerName: raw.playerName ?? null,
      relatedPlayerName: raw.relatedPlayerName ?? null,
      info: raw.info ?? null,
      addition: raw.addition ?? null,
      result: raw.result ?? null,
      extraMinute: raw.extraMinute ?? null,
      unknownProviderType: mapped.unknown,
      sortOrder: raw.sortOrder ?? null,
    },
    requiresPrimaryPlayer:
      mapped.eventType !== "SUBSTITUTION" &&
      mapped.eventType !== "CORNER_WON" &&
      mapped.eventType !== "VAR_REVERSAL",
  };

  if (
    (mapped.eventType === "GOAL" || raw.typeCode === 14 || raw.typeCode === 16) &&
    secondaryExternalPlayerId &&
    mapped.eventType === "GOAL"
  ) {
    draft.derivedAssist = {
      providerEventId: `${raw.providerEventId}:assist`,
      primaryExternalPlayerId: secondaryExternalPlayerId,
    };
  }

  if (mapped.eventType === "SUBSTITUTION") {
    // Sportmonks: player_id = off, related_player_id = on (same convention as local-dev).
    draft.requiresPrimaryPlayer = false;
  }

  return draft;
}

export function normalizeCanonicalType(type: string): ScoringEventType {
  if (isScoringEventType(type)) {
    return type;
  }
  return "SHOT";
}

/**
 * Convert a recorded Sportmonks fixture payload into RawProviderEvent rows.
 */
export function sportmonksFixtureToRawEvents(fixture: {
  id: number | string;
  events?: Array<Record<string, unknown>>;
  timeline?: Array<Record<string, unknown>>;
  starting_at?: string;
}): RawProviderEvent[] {
  const fixtureId = String(fixture.id);
  const rows: RawProviderEvent[] = [];
  for (const event of fixture.events ?? []) {
    rows.push({
      provider: "sportmonks",
      providerEventId: String(event.id),
      externalFixtureId: fixtureId,
      typeCode: event.type_id as number,
      subTypeCode: (event.sub_type_id as number | null | undefined) ?? null,
      minute: (event.minute as number | null | undefined) ?? null,
      extraMinute: (event.extra_minute as number | null | undefined) ?? null,
      period: (event.period_id as number | null | undefined) ?? null,
      sortOrder: (event.sort_order as number | null | undefined) ?? null,
      occurredAt: fixture.starting_at ?? null,
      primaryExternalPlayerId: (event.player_id as number | null | undefined) ?? null,
      secondaryExternalPlayerId: (event.related_player_id as number | null | undefined) ?? null,
      externalTeamId: (event.participant_id as number | null | undefined) ?? null,
      playerName: (event.player_name as string | null | undefined) ?? null,
      relatedPlayerName: (event.related_player_name as string | null | undefined) ?? null,
      info: (event.info as string | null | undefined) ?? null,
      addition: (event.addition as string | null | undefined) ?? null,
      result: (event.result as string | null | undefined) ?? null,
      raw: event,
    });
  }
  for (const event of fixture.timeline ?? []) {
    rows.push({
      provider: "sportmonks",
      providerEventId: `timeline:${String(event.id)}`,
      externalFixtureId: fixtureId,
      typeCode: event.type_id as number,
      subTypeCode: null,
      minute: (event.minute as number | null | undefined) ?? null,
      extraMinute: (event.extra_minute as number | null | undefined) ?? null,
      period: (event.period_id as number | null | undefined) ?? null,
      sortOrder: (event.sort_order as number | null | undefined) ?? null,
      occurredAt: fixture.starting_at ?? null,
      primaryExternalPlayerId: (event.player_id as number | null | undefined) ?? null,
      secondaryExternalPlayerId: (event.related_player_id as number | null | undefined) ?? null,
      externalTeamId: (event.participant_id as number | null | undefined) ?? null,
      raw: event,
    });
  }
  return rows;
}
