import { newId } from "../shared/ids.js";
import type { PlayerRole } from "../domain/football/roles.js";
import type { ProviderIdMap } from "../sports/id-map.js";
import type { SquadRecord } from "../football/store.js";

/**
 * Sportmonks lineup type_id: 11 starting XI, 12 bench/substitute.
 * Never invents KICKR players. Unresolved external ids are diagnostics only.
 */

export interface ProviderLineupRow {
  externalPlayerId: string;
  externalTeamId: string | null;
  typeId: number | null;
  positionCode?: string | null;
  jerseyNumber?: number | null;
  raw: Record<string, unknown>;
}

export interface UnresolvedLineupPlayer {
  id: string;
  provider: string;
  matchId: string | null;
  externalFixtureId: string | null;
  externalPlayerId: string;
  externalTeamId: string | null;
  reason: string;
  rawPayload: Record<string, unknown>;
  createdAt: string;
}

export interface LineupSyncResult {
  upserts: SquadRecord[];
  unresolved: UnresolvedLineupPlayer[];
}

export interface LineupSyncStore {
  listSquad(matchId: string): Promise<SquadRecord[]>;
  listPlayers(): Promise<Array<{ id: string; position: PlayerRole; clubId: string; providerId: string }>>;
  upsertSquadRow(row: SquadRecord): Promise<void>;
}

function startingFromType(typeId: number | null): "STARTER" | "BENCH" | "UNKNOWN" {
  if (typeId === 11) {
    return "STARTER";
  }
  if (typeId === 12) {
    return "BENCH";
  }
  return "UNKNOWN";
}

export function syncProviderLineups(input: {
  provider: string;
  matchId: string;
  externalFixtureId: string;
  rows: readonly ProviderLineupRow[];
  idMap: ProviderIdMap;
  existingSquad: readonly SquadRecord[];
  players: ReadonlyArray<{ id: string; position: PlayerRole; clubId: string }>;
  nowIso: string;
}): LineupSyncResult {
  const byPlayer = new Map(input.existingSquad.map((row) => [row.playerId, row]));
  const playerMeta = new Map(input.players.map((player) => [player.id, player]));
  const upserts: SquadRecord[] = [];
  const unresolved: UnresolvedLineupPlayer[] = [];

  for (const row of input.rows) {
    const kickrPlayerId = input.idMap.get(input.provider, "player", row.externalPlayerId);
    if (!kickrPlayerId) {
      unresolved.push({
        id: newId(),
        provider: input.provider,
        matchId: input.matchId,
        externalFixtureId: input.externalFixtureId,
        externalPlayerId: row.externalPlayerId,
        externalTeamId: row.externalTeamId,
        reason: "unresolved_lineup_player",
        rawPayload: row.raw,
        createdAt: input.nowIso,
      });
      continue;
    }
    const player = playerMeta.get(kickrPlayerId);
    if (!player) {
      unresolved.push({
        id: newId(),
        provider: input.provider,
        matchId: input.matchId,
        externalFixtureId: input.externalFixtureId,
        externalPlayerId: row.externalPlayerId,
        externalTeamId: row.externalTeamId,
        reason: "mapped_player_missing_from_store",
        rawPayload: row.raw,
        createdAt: input.nowIso,
      });
      continue;
    }
    const clubId =
      (row.externalTeamId
        ? input.idMap.get(input.provider, "club", row.externalTeamId)
        : null) ?? player.clubId;
    const startingStatus = startingFromType(row.typeId);
    const existing = byPlayer.get(kickrPlayerId);
    const next: SquadRecord = {
      id: existing?.id ?? newId(),
      matchId: input.matchId,
      playerId: kickrPlayerId,
      clubId,
      fantasyPosition: player.position,
      creditValue: existing?.creditValue ?? 0,
      availability: existing?.availability ?? "AVAILABLE",
      startingStatus,
      squadStatus: "INCLUDED",
      providerId: existing?.providerId ?? `${input.provider}-lineup-${row.externalPlayerId}`,
      sourceVersion: `${input.provider}-lineup`,
      sourcedAt: input.nowIso,
    };
    upserts.push(next);
    byPlayer.set(kickrPlayerId, next);
  }

  return { upserts, unresolved };
}

export function extractSportmonksLineups(
  fixture: Record<string, unknown>,
): ProviderLineupRow[] {
  const lineups = fixture.lineups;
  if (!Array.isArray(lineups)) {
    return [];
  }
  const rows: ProviderLineupRow[] = [];
  for (const item of lineups) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const playerId = row.player_id;
    if (playerId === null || playerId === undefined || playerId === "") {
      continue;
    }
    rows.push({
      externalPlayerId: String(playerId),
      externalTeamId:
        row.team_id === null || row.team_id === undefined ? null : String(row.team_id),
      typeId: typeof row.type_id === "number" ? row.type_id : null,
      positionCode: row.position_id === null || row.position_id === undefined ? null : String(row.position_id),
      jerseyNumber: typeof row.jersey_number === "number" ? row.jersey_number : null,
      raw: row,
    });
  }
  return rows;
}
