import { createHash } from "node:crypto";
import type { ScoringEventType } from "../domain/scoring/events.js";
import {
  LOCAL_DEV_CLUB_A,
  LOCAL_DEV_CLUB_B,
  buildLocalDevCatalog,
} from "./local-dev-provider.js";
import type { ProviderEvent, SportsCatalog } from "./types.js";

/**
 * Deterministic Phase 5 replay match built on the local-dev catalog.
 * Includes starting XI, bench, goal, assist, shot, SOT, corner, yellow,
 * substitution, and VAR reversal. Not a live feed.
 */

export const LOCAL_DEV_REPLAY_MATCH = "10000000-0000-4000-8000-000000000010";

function eventHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

function evt(
  partial: Omit<ProviderEvent, "createdAt" | "metadata" | "provider" | "matchId" | "supersedesEventId"> & {
    metadata?: Record<string, unknown>;
    supersedesEventId?: string | null;
    matchId?: string;
  },
): ProviderEvent {
  const metadata = {
    label: "phase5 replay fixture, not a live feed",
    ...(partial.metadata ?? {}),
  };
  return {
    matchId: partial.matchId ?? LOCAL_DEV_REPLAY_MATCH,
    provider: "local-dev",
    supersedesEventId: partial.supersedesEventId ?? null,
    createdAt: "2026-10-02T17:00:00.000Z",
    metadata,
    eventId: partial.eventId,
    providerEventId: partial.providerEventId,
    sequence: partial.sequence,
    timestamp: partial.timestamp,
    matchMinute: partial.matchMinute,
    period: partial.period,
    eventType: partial.eventType,
    primaryPlayerId: partial.primaryPlayerId,
    secondaryPlayerId: partial.secondaryPlayerId,
    teamId: partial.teamId,
  };
}

export function buildPhase5ReplayCatalog(): SportsCatalog {
  const base = buildLocalDevCatalog();
  const playersA = base.players.filter((player) => player.clubId === LOCAL_DEV_CLUB_A);
  const playersB = base.players.filter((player) => player.clubId === LOCAL_DEV_CLUB_B);
  const byShort = (clubPlayers: typeof playersA, short: string) => {
    const found = clubPlayers.find((player) => player.shortName === short);
    if (!found) {
      throw new Error(`replay catalog missing ${short}`);
    }
    return found;
  };

  const goal = byShort(playersA, "AF1");
  const assist = byShort(playersA, "AM1");
  const shot = byShort(playersA, "AM2");
  const sot = byShort(playersA, "AF2");
  const corner = byShort(playersB, "BM1");
  const yellow = byShort(playersB, "BD1");
  const off = byShort(playersA, "AM3");
  const on = byShort(playersA, "AM4");

  const goalEventId = "60000000-0000-4000-8000-000000000101";
  const events: ProviderEvent[] = [
    evt({
      eventId: goalEventId,
      providerEventId: "replay-evt-goal",
      sequence: 1,
      timestamp: "2026-10-02T15:12:00.000Z",
      matchMinute: 12,
      period: "1",
      eventType: "GOAL",
      primaryPlayerId: goal.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
      metadata: { rawEventHash: eventHash({ t: "GOAL", p: goal.providerId }) },
    }),
    evt({
      eventId: "60000000-0000-4000-8000-000000000102",
      providerEventId: "replay-evt-assist",
      sequence: 2,
      timestamp: "2026-10-02T15:12:00.000Z",
      matchMinute: 12,
      period: "1",
      eventType: "ASSIST",
      primaryPlayerId: assist.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
    }),
    evt({
      eventId: "60000000-0000-4000-8000-000000000103",
      providerEventId: "replay-evt-shot",
      sequence: 3,
      timestamp: "2026-10-02T15:18:00.000Z",
      matchMinute: 18,
      period: "1",
      eventType: "SHOT" as ScoringEventType,
      primaryPlayerId: shot.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
    }),
    evt({
      eventId: "60000000-0000-4000-8000-000000000104",
      providerEventId: "replay-evt-sot",
      sequence: 4,
      timestamp: "2026-10-02T15:22:00.000Z",
      matchMinute: 22,
      period: "1",
      eventType: "SHOT_ON_TARGET",
      primaryPlayerId: sot.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
    }),
    evt({
      eventId: "60000000-0000-4000-8000-000000000105",
      providerEventId: "replay-evt-corner",
      sequence: 5,
      timestamp: "2026-10-02T15:30:00.000Z",
      matchMinute: 30,
      period: "1",
      eventType: "CORNER_WON",
      primaryPlayerId: corner.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_B,
    }),
    evt({
      eventId: "60000000-0000-4000-8000-000000000106",
      providerEventId: "replay-evt-yellow",
      sequence: 6,
      timestamp: "2026-10-02T15:40:00.000Z",
      matchMinute: 40,
      period: "1",
      eventType: "YELLOW_CARD",
      primaryPlayerId: yellow.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_B,
    }),
    evt({
      eventId: "60000000-0000-4000-8000-000000000107",
      providerEventId: "replay-evt-sub",
      sequence: 7,
      timestamp: "2026-10-02T16:05:00.000Z",
      matchMinute: 60,
      period: "2",
      eventType: "SUBSTITUTION",
      primaryPlayerId: off.id,
      secondaryPlayerId: on.id,
      teamId: LOCAL_DEV_CLUB_A,
    }),
    evt({
      eventId: "60000000-0000-4000-8000-000000000108",
      providerEventId: "replay-evt-var",
      sequence: 8,
      timestamp: "2026-10-02T16:20:00.000Z",
      matchMinute: 75,
      period: "2",
      eventType: "VAR_REVERSAL",
      primaryPlayerId: goal.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
      supersedesEventId: goalEventId,
      metadata: { correctionType: "VAR_REVERSAL" },
    }),
  ];

  const squad = base.squad
    .filter((row) => row.matchId === base.matches[0]?.id)
    .map((row, index) => ({
      ...row,
      id: `50000000-0000-4000-8000-0010${String(index + 1).padStart(8, "0")}`,
      matchId: LOCAL_DEV_REPLAY_MATCH,
    }));

  return {
    clubs: base.clubs,
    players: base.players,
    matches: [
      ...base.matches,
      {
        id: LOCAL_DEV_REPLAY_MATCH,
        homeClubId: LOCAL_DEV_CLUB_A,
        awayClubId: LOCAL_DEV_CLUB_B,
        kickoffAt: "2026-10-02T15:00:00.000Z",
        competition: "DEV Cup Replay",
        venue: "Replay Stadium",
        externalFixtureId: "dev-fixture-replay",
        status: "LIVE",
        lineupAvailable: true,
        dataSource: {
          provider: "local-dev",
          label: "phase5 deterministic replay, not a live feed",
          fetchedAt: "2026-10-02T14:00:00.000Z",
        },
      },
    ],
    squad: [...base.squad, ...squad],
    events: [...base.events, ...events],
  };
}

/** Ordered raw drafts for pipeline replay tests (provider ids = local-dev providerId). */
export function buildReplayNormalizedDrafts(): Array<{
  provider: string;
  providerEventId: string;
  externalFixtureId: string;
  sequence: number;
  timestamp: string;
  timestampSource: "provider" | "kickoff_plus_minute";
  matchMinute: number | null;
  period: string | null;
  eventType: ScoringEventType;
  primaryExternalPlayerId: string | null;
  secondaryExternalPlayerId: string | null;
  externalTeamId: string | null;
  correctionType: "VAR_REVERSAL" | null;
  relatedProviderEventId: string | null;
  providerVersion: string | null;
  rawEventHash: string;
  metadata: Record<string, unknown>;
  requiresPrimaryPlayer: boolean;
  supersedesProviderEventId?: string;
}> {
  const catalog = buildPhase5ReplayCatalog();
  const matchEvents = catalog.events.filter((event) => event.matchId === LOCAL_DEV_REPLAY_MATCH);
  const players = new Map(catalog.players.map((player) => [player.id, player]));
  const clubs = new Map(catalog.clubs.map((club) => [club.id, club]));
  return matchEvents.map((event) => ({
    provider: "local-dev",
    providerEventId: event.providerEventId,
    externalFixtureId: "dev-fixture-replay",
    sequence: event.sequence,
    timestamp: event.timestamp,
    timestampSource: "kickoff_plus_minute" as const,
    matchMinute: event.matchMinute,
    period: event.period,
    eventType: event.eventType,
    primaryExternalPlayerId: event.primaryPlayerId
      ? (players.get(event.primaryPlayerId)?.providerId ?? null)
      : null,
    secondaryExternalPlayerId: event.secondaryPlayerId
      ? (players.get(event.secondaryPlayerId)?.providerId ?? null)
      : null,
    externalTeamId: event.teamId ? (clubs.get(event.teamId)?.providerId ?? null) : null,
    correctionType: event.eventType === "VAR_REVERSAL" ? ("VAR_REVERSAL" as const) : null,
    relatedProviderEventId: event.eventType === "VAR_REVERSAL" ? "replay-evt-goal" : null,
    providerVersion: "local-dev-replay-1",
    rawEventHash: eventHash({ id: event.providerEventId, type: event.eventType }),
    metadata: { ...event.metadata },
    requiresPrimaryPlayer: event.eventType !== "SUBSTITUTION",
    supersedesProviderEventId:
      event.eventType === "VAR_REVERSAL" ? "replay-evt-goal" : undefined,
  }));
}
