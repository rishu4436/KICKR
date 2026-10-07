import { createHash } from "node:crypto";
import type { PlayerRole } from "../domain/football/roles.js";
import type {
  ProviderClub,
  ProviderMatch,
  ProviderPlayer,
  ProviderSquadRow,
  SportsCatalog,
} from "./types.js";
import { mapSportmonksPosition, UnsupportedPositionError } from "./positions.js";
import { mapSportmonksStateToMatchStatus } from "./poll-schedule.js";
import { SPORTMONKS_PROVIDER_NAME } from "./sportmonks-provider.js";

/**
 * Bootstrap a single LIVE Sportmonks fixture into KICKR domain catalog rows.
 * Creates clubs/players/match/squad from provider payload (intentional ingest).
 * Uses KICKR crest/avatar fallbacks only — never Sportmonks logos/photos.
 * Fail visibly on unsupported position mappings.
 */

export const LIVE_DATA_SOURCE = {
  provider: SPORTMONKS_PROVIDER_NAME,
  label: "LIVE DATA — Sportmonks Football API v3",
} as const;

/** Deterministic UUID from provider entity key (stable across restarts). */
export function deterministicUuid(namespace: string, externalId: string): string {
  const hex = createHash("sha256")
    .update(`kickr:${namespace}:${externalId}`, "utf8")
    .digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, "0")}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

export interface LiveBootstrapResult {
  catalog: SportsCatalog;
  fixtureId: string;
  matchId: string;
  homeClubName: string;
  awayClubName: string;
  playerCount: number;
  clubCount: number;
  unsupportedPositions: Array<{ playerId: string; positionId: unknown; name: string | null }>;
}

function shortName(name: string, fallback: string): string {
  const cleaned = name.trim();
  if (cleaned.length <= 12) return cleaned || fallback;
  const parts = cleaned.split(/\s+/);
  if (parts.length >= 2) {
    return `${parts[0]![0]}.${parts[parts.length - 1]}`.slice(0, 12);
  }
  return cleaned.slice(0, 12);
}

function participantLocation(meta: unknown): "home" | "away" | null {
  if (!meta || typeof meta !== "object") return null;
  const loc = (meta as { location?: unknown }).location;
  if (loc === "home" || loc === "away") return loc;
  return null;
}

export function bootstrapLiveFixture(
  fixture: Record<string, unknown>,
  options: { nowIso?: string; creditDefault?: number } = {},
): LiveBootstrapResult {
  const fixtureId = String(fixture.id ?? "");
  if (!fixtureId) {
    throw new Error("Sportmonks fixture missing id");
  }
  const nowIso = options.nowIso ?? new Date().toISOString();
  const creditDefault = options.creditDefault ?? 8;
  const participants = Array.isArray(fixture.participants)
    ? (fixture.participants as Array<Record<string, unknown>>)
    : [];
  if (participants.length < 2) {
    throw new Error(`Sportmonks fixture ${fixtureId} needs at least 2 participants`);
  }

  let home: Record<string, unknown> | null = null;
  let away: Record<string, unknown> | null = null;
  for (const p of participants) {
    const loc = participantLocation(p.meta);
    if (loc === "home") home = p;
    if (loc === "away") away = p;
  }
  if (!home) home = participants[0]!;
  if (!away) away = participants.find((p) => p !== home) ?? participants[1]!;

  const clubs: ProviderClub[] = [];
  const clubIdByExternal = new Map<string, string>();
  for (const p of [home, away]) {
    const ext = String(p.id);
    const kickrId = deterministicUuid("club", ext);
    clubIdByExternal.set(ext, kickrId);
    const name = String(p.name ?? `Club ${ext}`);
    clubs.push({
      id: kickrId,
      name,
      shortName: String(p.short_code ?? shortName(name, ext)),
      providerId: ext,
    });
  }

  const homeClubId = clubIdByExternal.get(String(home.id))!;
  const awayClubId = clubIdByExternal.get(String(away.id))!;
  const matchId = deterministicUuid("fixture", fixtureId);
  const stateId = typeof fixture.state_id === "number" ? fixture.state_id : null;
  const status = mapSportmonksStateToMatchStatus(stateId);
  const kickoffRaw = typeof fixture.starting_at === "string" ? fixture.starting_at : nowIso;
  const kickoffAt = new Date(kickoffRaw.includes("T") ? kickoffRaw : kickoffRaw.replace(" ", "T") + "Z").toISOString();
  const lineups = Array.isArray(fixture.lineups)
    ? (fixture.lineups as Array<Record<string, unknown>>)
    : [];
  const lineupAvailable = lineups.some((row) => row.type_id === 11);

  const match: ProviderMatch = {
    id: matchId,
    homeClubId,
    awayClubId,
    kickoffAt,
    competition: String(fixture.name ?? "LIVE Match").includes(" vs ")
      ? "LIVE"
      : String((fixture as { league?: { name?: string } }).league?.name ?? "LIVE"),
    venue: null,
    externalFixtureId: fixtureId,
    status: status === "HALFTIME" ? "HALFTIME" : status === "LIVE" ? "LIVE" : status === "FULL_TIME" ? "FULL_TIME" : "SCHEDULED",
    lineupAvailable,
    dataSource: {
      provider: LIVE_DATA_SOURCE.provider,
      label: LIVE_DATA_SOURCE.label,
      fetchedAt: nowIso,
    },
  };

  const players: ProviderPlayer[] = [];
  const squad: ProviderSquadRow[] = [];
  const unsupportedPositions: LiveBootstrapResult["unsupportedPositions"] = [];
  const seenPlayers = new Set<string>();

  for (const row of lineups) {
    const playerExt = row.player_id === null || row.player_id === undefined ? null : String(row.player_id);
    if (!playerExt) continue;
    const teamExt = row.team_id === null || row.team_id === undefined ? null : String(row.team_id);
    const clubId = teamExt ? clubIdByExternal.get(teamExt) : null;
    if (!clubId) {
      unsupportedPositions.push({
        playerId: playerExt,
        positionId: row.position_id,
        name: typeof row.player_name === "string" ? row.player_name : null,
      });
      continue;
    }

    let position: PlayerRole;
    try {
      position = mapSportmonksPosition(row.position_id as number | string | null);
    } catch (error) {
      if (error instanceof UnsupportedPositionError) {
        unsupportedPositions.push({
          playerId: playerExt,
          positionId: row.position_id,
          name: typeof row.player_name === "string" ? row.player_name : null,
        });
        continue;
      }
      throw error;
    }

    const playerId = deterministicUuid("player", playerExt);
    const displayName =
      typeof row.player_name === "string" && row.player_name.trim()
        ? row.player_name.trim()
        : `Player ${playerExt}`;

    if (!seenPlayers.has(playerExt)) {
      seenPlayers.add(playerExt);
      players.push({
        id: playerId,
        displayName,
        shortName: shortName(displayName, playerExt),
        position,
        clubId,
        active: true,
        providerId: playerExt,
      });
    }

    const typeId = typeof row.type_id === "number" ? row.type_id : null;
    const startingStatus =
      typeId === 11 ? "STARTER" : typeId === 12 ? "BENCH" : "UNKNOWN";

    squad.push({
      id: deterministicUuid("squad", `${fixtureId}:${playerExt}`),
      matchId,
      playerId,
      clubId,
      fantasyPosition: position,
      creditValue: creditDefault,
      availability: "AVAILABLE",
      startingStatus,
      squadStatus: "INCLUDED",
      providerId: playerExt,
      sourceVersion: lineupAvailable ? "sportmonks-lineup" : "sportmonks-squad",
      sourcedAt: nowIso,
    });
  }

  if (unsupportedPositions.length > 0 && players.length === 0) {
    throw new UnsupportedPositionError(
      unsupportedPositions[0]!.positionId as number | string | null,
      `All lineup players have unsupported positions for fixture ${fixtureId}`,
    );
  }

  return {
    catalog: {
      clubs,
      players,
      matches: [match],
      squad,
      events: [],
    },
    fixtureId,
    matchId,
    homeClubName: String(home.name ?? "Home"),
    awayClubName: String(away.name ?? "Away"),
    playerCount: players.length,
    clubCount: clubs.length,
    unsupportedPositions,
  };
}

/** Enforce exactly one match in a catalog (LIVE/DEMO strict modes). */
export function assertExactlyOneMatch(catalog: SportsCatalog, context: string): void {
  if (catalog.matches.length !== 1) {
    throw new Error(`${context}: expected exactly one match, got ${catalog.matches.length}`);
  }
}
