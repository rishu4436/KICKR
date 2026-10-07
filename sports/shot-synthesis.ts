import { createHash } from "node:crypto";
import type { NormalizedEventDraft } from "./normalize.js";
import { hashRawEvent } from "./normalize.js";

/**
 * Sportmonks shots-on-target (lineup detail type_id 86) are cumulative totals.
 * Persist observed_total durably (Postgres). When the total increases, emit
 * deterministic synthetic SHOT_ON_TARGET events for new ordinals.
 * When the provider corrects downward (e.g. 3→2), append an explicit correction
 * that supersedes ordinal 3 — never delete historical events.
 */

export const SPORTMONKS_SHOTS_ON_TARGET_TYPE_ID = 86;
export const SHOT_ON_TARGET_STAT = "SHOT_ON_TARGET";

export interface PlayerStatObservation {
  fixtureId: string;
  playerId: string; // external provider player id
  statType: typeof SHOT_ON_TARGET_STAT;
  observedTotal: number;
  updatedAt: string;
}

export interface PlayerStatObservationStore {
  getObservation(
    fixtureId: string,
    playerId: string,
    statType: string,
  ): Promise<PlayerStatObservation | null>;
  upsertObservation(row: PlayerStatObservation): Promise<void>;
}

export class InMemoryPlayerStatObservationStore implements PlayerStatObservationStore {
  private readonly rows = new Map<string, PlayerStatObservation>();

  private key(fixtureId: string, playerId: string, statType: string): string {
    return `${fixtureId}|${playerId}|${statType}`;
  }

  async getObservation(
    fixtureId: string,
    playerId: string,
    statType: string,
  ): Promise<PlayerStatObservation | null> {
    return this.rows.get(this.key(fixtureId, playerId, statType)) ?? null;
  }

  async upsertObservation(row: PlayerStatObservation): Promise<void> {
    this.rows.set(this.key(row.fixtureId, row.playerId, row.statType), { ...row });
  }

  clear(): void {
    this.rows.clear();
  }
}

/** Deterministic provider event id for synthetic SOT ordinal. */
export function shotOnTargetProviderEventId(
  fixtureId: string,
  playerId: string,
  ordinal: number,
): string {
  const digest = createHash("sha256")
    .update(`${fixtureId}${playerId}${SHOT_ON_TARGET_STAT}${ordinal}`, "utf8")
    .digest("hex");
  return `synth:sot:${digest}`;
}

/** SHA256 hex used in tests / diagnostics (same input as provider event id body). */
export function shotOnTargetOrdinalHash(
  fixtureId: string,
  playerId: string,
  ordinal: number,
): string {
  return createHash("sha256")
    .update(`${fixtureId}${playerId}${SHOT_ON_TARGET_STAT}${ordinal}`, "utf8")
    .digest("hex");
}

export function shotOnTargetCorrectionProviderEventId(
  fixtureId: string,
  playerId: string,
  ordinal: number,
): string {
  return `synth:sot-correction:${shotOnTargetOrdinalHash(fixtureId, playerId, ordinal)}`;
}

export interface ShotSynthesisInput {
  fixtureId: string;
  playerId: string; // external
  teamId: string | null;
  observedTotal: number;
  previousTotal: number;
  kickoffAt: string | null;
  nowIso: string;
  sequenceBase: number;
}

export interface ShotSynthesisResult {
  drafts: NormalizedEventDraft[];
  nextObservedTotal: number;
}

/**
 * Diff previous vs observed cumulative SOT total and emit append-only drafts.
 */
export function synthesizeShotOnTargetEvents(input: ShotSynthesisInput): ShotSynthesisResult {
  const drafts: NormalizedEventDraft[] = [];
  const prev = Math.max(0, Math.floor(input.previousTotal));
  const next = Math.max(0, Math.floor(input.observedTotal));

  if (next > prev) {
    for (let ordinal = prev + 1; ordinal <= next; ordinal += 1) {
      const providerEventId = shotOnTargetProviderEventId(
        input.fixtureId,
        input.playerId,
        ordinal,
      );
      const raw = {
        synthetic: true,
        statType: SHOT_ON_TARGET_STAT,
        fixtureId: input.fixtureId,
        playerId: input.playerId,
        ordinal,
        observedTotal: next,
      };
      drafts.push({
        provider: "sportmonks",
        providerEventId,
        externalFixtureId: input.fixtureId,
        sequence: input.sequenceBase + drafts.length + 1,
        timestamp: input.nowIso,
        timestampSource: "provider",
        matchMinute: null,
        period: null,
        eventType: "SHOT_ON_TARGET",
        primaryExternalPlayerId: input.playerId,
        secondaryExternalPlayerId: null,
        externalTeamId: input.teamId,
        correctionType: null,
        relatedProviderEventId: null,
        providerVersion: "v3",
        rawEventHash: hashRawEvent(raw),
        metadata: {
          synthetic: true,
          synthesis: "SHOT_ON_TARGET",
          ordinal,
          observedTotal: next,
          previousTotal: prev,
          sha256: shotOnTargetOrdinalHash(input.fixtureId, input.playerId, ordinal),
        },
        requiresPrimaryPlayer: true,
      });
    }
  } else if (next < prev) {
    // Correction: supersede ordinals next+1 .. prev (do not delete).
    for (let ordinal = next + 1; ordinal <= prev; ordinal += 1) {
      const originalId = shotOnTargetProviderEventId(input.fixtureId, input.playerId, ordinal);
      const providerEventId = shotOnTargetCorrectionProviderEventId(
        input.fixtureId,
        input.playerId,
        ordinal,
      );
      const raw = {
        synthetic: true,
        correction: true,
        statType: SHOT_ON_TARGET_STAT,
        fixtureId: input.fixtureId,
        playerId: input.playerId,
        ordinal,
        observedTotal: next,
        previousTotal: prev,
      };
      drafts.push({
        provider: "sportmonks",
        providerEventId,
        externalFixtureId: input.fixtureId,
        sequence: input.sequenceBase + drafts.length + 1,
        timestamp: input.nowIso,
        timestampSource: "provider",
        matchMinute: null,
        period: null,
        eventType: "VAR_REVERSAL",
        primaryExternalPlayerId: input.playerId,
        secondaryExternalPlayerId: null,
        externalTeamId: input.teamId,
        correctionType: "PROVIDER_CORRECTION",
        relatedProviderEventId: originalId,
        providerVersion: "v3",
        rawEventHash: hashRawEvent(raw),
        metadata: {
          synthetic: true,
          synthesis: "SHOT_ON_TARGET_CORRECTION",
          ordinal,
          observedTotal: next,
          previousTotal: prev,
          supersedesSyntheticOrdinal: ordinal,
          sha256: shotOnTargetOrdinalHash(input.fixtureId, input.playerId, ordinal),
        },
        requiresPrimaryPlayer: false,
      });
    }
  }
  // next === prev → no-op (repeated identical poll)

  return { drafts, nextObservedTotal: next };
}

/** Extract cumulative SOT totals from Sportmonks lineup.details (type_id 86). */
export function extractShotOnTargetTotals(
  fixture: Record<string, unknown>,
): Array<{ playerId: string; teamId: string | null; total: number }> {
  const lineups = fixture.lineups;
  if (!Array.isArray(lineups)) {
    return [];
  }
  const out: Array<{ playerId: string; teamId: string | null; total: number }> = [];
  for (const item of lineups) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const playerId = row.player_id;
    if (playerId === null || playerId === undefined || playerId === "") continue;
    const details = row.details;
    if (!Array.isArray(details)) continue;
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const d = detail as Record<string, unknown>;
      if (d.type_id !== SPORTMONKS_SHOTS_ON_TARGET_TYPE_ID) continue;
      const data = d.data as { value?: unknown } | null | undefined;
      const value = typeof data?.value === "number" ? data.value : Number(data?.value);
      if (!Number.isFinite(value)) continue;
      out.push({
        playerId: String(playerId),
        teamId: row.team_id === null || row.team_id === undefined ? null : String(row.team_id),
        total: Math.max(0, Math.floor(value)),
      });
    }
  }
  return out;
}
