import { isPlayerRole } from "../domain/football/roles.js";
import { transition } from "../domain/state-machine.js";
import type { MatchState, TeamState } from "../domain/state-machine.js";
import { isScoringEventType } from "../domain/scoring/events.js";
import type { SportsCatalog } from "../sports/types.js";
import type {
  ClubRecord,
  FantasyTeamRecord,
  FantasyTeamVersionRecord,
  FootballStore,
  MatchRecord,
  PlayerRecord,
  SquadRecord,
  StoredMatchEvent,
} from "../football/store.js";
import { asDate, asNullableString, asString } from "./mappers.js";
import type { Queryable } from "./types.js";

type Row = Record<string, unknown>;

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error("Expected an integer");
}

function asBool(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  throw new Error("Expected a boolean");
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  }
  throw new Error("Expected an object");
}

function mapMatch(row: Row): MatchRecord {
  return {
    id: asString(row.id),
    homeClubId: asString(row.home_club_id),
    awayClubId: asString(row.away_club_id),
    kickoffAt: asDate(row.kickoff_at).toISOString(),
    competition: asString(row.competition),
    venue: asNullableString(row.venue),
    externalFixtureId: asString(row.external_fixture_id),
    status: asString(row.status) as MatchState,
    lineupAvailable: asBool(row.lineup_available),
    dataSource: asObject(row.data_source) as MatchRecord["dataSource"],
  };
}

export function createPgFootballStore(db: Queryable): FootballStore {
  return {
    async listMatches() {
      const result = await db.query<Row>(
        `SELECT id, home_club_id, away_club_id, kickoff_at, competition, venue,
                external_fixture_id, status, lineup_available, data_source
         FROM matches ORDER BY kickoff_at ASC`,
      );
      return result.rows.map(mapMatch);
    },
    async getMatch(id) {
      const result = await db.query<Row>(
        `SELECT id, home_club_id, away_club_id, kickoff_at, competition, venue,
                external_fixture_id, status, lineup_available, data_source
         FROM matches WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? mapMatch(row) : null;
    },
    async getClub(id) {
      const result = await db.query<Row>(
        `SELECT id, name, short_name, provider_id FROM clubs WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const club: ClubRecord = {
        id: asString(row.id),
        name: asString(row.name),
        shortName: asString(row.short_name),
        providerId: asString(row.provider_id),
      };
      return club;
    },
    async listPlayers() {
      const result = await db.query<Row>(
        `SELECT id, display_name, short_name, position, club_id, active, provider_id FROM players`,
      );
      return result.rows.map((row) => {
        const position = asString(row.position);
        if (!isPlayerRole(position)) {
          throw new Error("Unknown player role");
        }
        const player: PlayerRecord = {
          id: asString(row.id),
          displayName: asString(row.display_name),
          shortName: asString(row.short_name),
          position,
          clubId: asString(row.club_id),
          active: asBool(row.active),
          providerId: asString(row.provider_id),
        };
        return player;
      });
    },
    async listSquad(matchId) {
      const result = await db.query<Row>(
        `SELECT id, match_id, player_id, club_id, fantasy_position, credit_value,
                availability, starting_status, squad_status, provider_id, source_version, sourced_at
         FROM match_squad WHERE match_id = $1`,
        [matchId],
      );
      return result.rows.map((row) => {
        const position = asString(row.fantasy_position);
        if (!isPlayerRole(position)) {
          throw new Error("Unknown fantasy position");
        }
        const squad: SquadRecord = {
          id: asString(row.id),
          matchId: asString(row.match_id),
          playerId: asString(row.player_id),
          clubId: asString(row.club_id),
          fantasyPosition: position,
          creditValue: asInt(row.credit_value),
          availability: asString(row.availability) as SquadRecord["availability"],
          startingStatus: asString(row.starting_status) as SquadRecord["startingStatus"],
          squadStatus: asString(row.squad_status) as SquadRecord["squadStatus"],
          providerId: asString(row.provider_id),
          sourceVersion: asString(row.source_version),
          sourcedAt: asDate(row.sourced_at).toISOString(),
        };
        return squad;
      });
    },
    async applyMatchTransition(id, to, now) {
      const current = await this.getMatch(id);
      if (!current) {
        throw new Error("match not found");
      }
      const next = transition("MATCH", current.status, to) as MatchState;
      await db.query(
        `UPDATE matches SET status = $2, updated_at = $3 WHERE id = $1`,
        [id, next, now],
      );
      const updated = await this.getMatch(id);
      if (!updated) {
        throw new Error("match not found");
      }
      return updated;
    },
    async createTeam(team) {
      await db.query(
        `INSERT INTO fantasy_teams (id, account_id, match_id, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [team.id, team.accountId, team.matchId, team.status, team.createdAt, team.updatedAt],
      );
    },
    async getTeam(id) {
      const result = await db.query<Row>(
        `SELECT id, account_id, match_id, status, created_at, updated_at FROM fantasy_teams WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const team: FantasyTeamRecord = {
        id: asString(row.id),
        accountId: asString(row.account_id),
        matchId: asString(row.match_id),
        status: asString(row.status) as TeamState,
        createdAt: asDate(row.created_at).toISOString(),
        updatedAt: asDate(row.updated_at).toISOString(),
      };
      return team;
    },
    async saveTeam(team) {
      await db.query(
        `UPDATE fantasy_teams SET status = $2, updated_at = $3 WHERE id = $1`,
        [team.id, team.status, team.updatedAt],
      );
    },
    async listVersions(teamId) {
      const result = await db.query<Row>(
        `SELECT id, team_id, version, match_id, player_ids, captain_id, vice_id,
                credits_used, validation_result, created_at
         FROM fantasy_team_versions WHERE team_id = $1 ORDER BY version ASC`,
        [teamId],
      );
      return result.rows.map((row) => {
        const playerIds = row.player_ids;
        if (!Array.isArray(playerIds) || !playerIds.every((id) => typeof id === "string")) {
          throw new Error("player_ids must be a string array");
        }
        const version: FantasyTeamVersionRecord = {
          id: asString(row.id),
          teamId: asString(row.team_id),
          version: asInt(row.version),
          matchId: asString(row.match_id),
          playerIds,
          captainId: asString(row.captain_id),
          viceId: asString(row.vice_id),
          creditsUsed: asInt(row.credits_used),
          validationResult: { valid: true, errors: [] },
          createdAt: asDate(row.created_at).toISOString(),
        };
        return version;
      });
    },
    async insertVersion(version) {
      await db.query(
        `INSERT INTO fantasy_team_versions (
           id, team_id, version, match_id, player_ids, captain_id, vice_id,
           credits_used, validation_result, created_at
         ) VALUES ($1, $2, $3, $4, $5::uuid[], $6, $7, $8, $9::jsonb, $10)`,
        [
          version.id,
          version.teamId,
          version.version,
          version.matchId,
          version.playerIds,
          version.captainId,
          version.viceId,
          version.creditsUsed,
          JSON.stringify(version.validationResult),
          version.createdAt,
        ],
      );
    },
    async listEvents(matchId) {
      const result = await db.query<Row>(
        `SELECT event_id, match_id, provider, provider_event_id, sequence, occurred_at,
                match_minute, period, event_type, primary_player_id, secondary_player_id,
                team_id, metadata, supersedes_event_id, created_at
         FROM match_events WHERE match_id = $1 ORDER BY sequence ASC`,
        [matchId],
      );
      return result.rows.map((row) => {
        const eventType = asString(row.event_type);
        if (!isScoringEventType(eventType)) {
          throw new Error("Unknown event type");
        }
        const event: StoredMatchEvent = {
          eventId: asString(row.event_id),
          matchId: asString(row.match_id),
          provider: asString(row.provider),
          providerEventId: asString(row.provider_event_id),
          sequence: asInt(row.sequence),
          timestamp: asDate(row.occurred_at).toISOString(),
          matchMinute: row.match_minute === null || row.match_minute === undefined ? null : asInt(row.match_minute),
          period: asNullableString(row.period),
          eventType,
          primaryPlayerId: asNullableString(row.primary_player_id),
          secondaryPlayerId: asNullableString(row.secondary_player_id),
          teamId: asNullableString(row.team_id),
          metadata: asObject(row.metadata),
          supersedesEventId: asNullableString(row.supersedes_event_id),
          createdAt: asDate(row.created_at).toISOString(),
        };
        return event;
      });
    },
    async upsertCatalog(catalog: SportsCatalog) {
      for (const club of catalog.clubs) {
        await db.query(
          `INSERT INTO clubs (id, name, short_name, provider_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (id) DO NOTHING`,
          [club.id, club.name, club.shortName, club.providerId],
        );
      }
      for (const player of catalog.players) {
        await db.query(
          `INSERT INTO players (id, display_name, short_name, position, club_id, active, provider_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT (id) DO NOTHING`,
          [
            player.id,
            player.displayName,
            player.shortName,
            player.position,
            player.clubId,
            player.active,
            player.providerId,
          ],
        );
      }
      for (const match of catalog.matches) {
        await db.query(
          `INSERT INTO matches (
             id, home_club_id, away_club_id, kickoff_at, competition, venue,
             external_fixture_id, status, lineup_available, data_source
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
           ON CONFLICT (id) DO NOTHING`,
          [
            match.id,
            match.homeClubId,
            match.awayClubId,
            match.kickoffAt,
            match.competition,
            match.venue,
            match.externalFixtureId,
            match.status,
            match.lineupAvailable,
            JSON.stringify(match.dataSource),
          ],
        );
      }
      for (const row of catalog.squad) {
        await db.query(
          `INSERT INTO match_squad (
             id, match_id, player_id, club_id, fantasy_position, credit_value,
             availability, starting_status, squad_status, provider_id, source_version, sourced_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           ON CONFLICT (id) DO NOTHING`,
          [
            row.id,
            row.matchId,
            row.playerId,
            row.clubId,
            row.fantasyPosition,
            row.creditValue,
            row.availability,
            row.startingStatus,
            row.squadStatus,
            row.providerId,
            row.sourceVersion,
            row.sourcedAt,
          ],
        );
      }
      for (const event of catalog.events) {
        await db.query(
          `INSERT INTO match_events (
             event_id, match_id, provider, provider_event_id, sequence, occurred_at,
             match_minute, period, event_type, primary_player_id, secondary_player_id,
             team_id, metadata, supersedes_event_id, created_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
           ON CONFLICT (event_id) DO NOTHING`,
          [
            event.eventId,
            event.matchId,
            event.provider,
            event.providerEventId,
            event.sequence,
            event.timestamp,
            event.matchMinute,
            event.period,
            event.eventType,
            event.primaryPlayerId,
            event.secondaryPlayerId,
            event.teamId,
            JSON.stringify(event.metadata),
            event.supersedesEventId,
            event.createdAt,
          ],
        );
      }
    },
  };
}

