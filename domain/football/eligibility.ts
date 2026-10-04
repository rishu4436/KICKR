import type { PlayerRole } from "./roles.js";

export interface EligibilityPlayer {
  id: string;
  active: boolean;
}

export interface EligibilitySquadRow {
  playerId: string;
  squadStatus: string;
  creditValue: number;
  fantasyPosition: PlayerRole;
}

/**
 * A player can be picked only from that match's official squad.
 * TODO: injury and suspension codes beyond squad status are unspecified.
 * UNAVAILABLE is displayed and does not, by itself, remove eligibility.
 */
export function isPlayerEligibleForMatch(
  player: EligibilityPlayer | null,
  squadRow: EligibilitySquadRow | null,
): boolean {
  if (!player || !player.active || !squadRow) {
    return false;
  }
  if (squadRow.playerId !== player.id) {
    return false;
  }
  if (squadRow.squadStatus !== "INCLUDED") {
    return false;
  }
  if (!Number.isInteger(squadRow.creditValue)) {
    return false;
  }
  return true;
}

export interface PoolPlayer {
  playerId: string;
  clubId: string;
  position: PlayerRole;
  credit: number;
  displayName: string;
  shortName: string;
  availability: string;
  startingStatus: string;
  active: boolean;
}

export function getMatchPlayerPool(
  players: readonly EligibilityPlayer[],
  squad: readonly (EligibilitySquadRow & {
    clubId: string;
    creditValue: number;
    fantasyPosition: PlayerRole;
    displayName: string;
    shortName: string;
    availability: string;
    startingStatus: string;
    active: boolean;
  })[],
): PoolPlayer[] {
  const byId = new Map(players.map((player) => [player.id, player]));
  const pool: PoolPlayer[] = [];
  for (const row of squad) {
    const player = byId.get(row.playerId) ?? null;
    if (!isPlayerEligibleForMatch(player, row)) {
      continue;
    }
    pool.push({
      playerId: row.playerId,
      clubId: row.clubId,
      position: row.fantasyPosition,
      credit: row.creditValue,
      displayName: row.displayName,
      shortName: row.shortName,
      availability: row.availability,
      startingStatus: row.startingStatus,
      active: row.active,
    });
  }
  return pool;
}

export function getPlayersByPosition(
  pool: readonly PoolPlayer[],
  position: PlayerRole,
): PoolPlayer[] {
  return pool.filter((player) => player.position === position);
}
