import type { AuditStore } from "../audit/types.js";
import { calculateCreditsUsed } from "../domain/football/credits.js";
import { getMatchPlayerPool, getPlayersByPosition, isPlayerEligibleForMatch } from "../domain/football/eligibility.js";
import type { PlayerRole } from "../domain/football/roles.js";
import { canBuildXi, matchBucket, type MatchBucket } from "../domain/football/presentation.js";
import { validateFantasyTeam, type FantasyRules, type TeamValidationResult } from "../domain/football/validate-team.js";
import { transition } from "../domain/state-machine.js";
import type { MatchState, TeamState } from "../domain/state-machine.js";
import { newId } from "../shared/ids.js";
import { AppError } from "../shared/errors.js";
import type { RequestContext } from "../auth/types.js";
import type {
  FantasyTeamRecord,
  FantasyTeamVersionRecord,
  FootballStore,
  MatchRecord,
  PlayerRecord,
  SquadRecord,
} from "./store.js";

export interface MatchView {
  id: string;
  competition: string;
  kickoffAt: string;
  status: MatchState;
  venue: string | null;
  lineupAvailable: boolean;
  canBuildXi: boolean;
  bucket: MatchBucket;
  externalFixtureId: string;
  dataSource: MatchRecord["dataSource"];
  home: { id: string; name: string; shortName: string };
  away: { id: string; name: string; shortName: string };
}

export interface PlayerView {
  playerId: string;
  displayName: string;
  shortName: string;
  position: PlayerRole;
  clubId: string;
  clubName: string;
  credit: number;
  availability: string;
  startingStatus: string;
  squadStatus: string;
}

export class FootballService {
  constructor(
    private readonly store: FootballStore,
    private readonly audit: AuditStore,
    private readonly rules: FantasyRules,
  ) {}

  async listMatches(bucket?: MatchBucket): Promise<MatchView[]> {
    const matches = await this.store.listMatches();
    const views: MatchView[] = [];
    for (const match of matches) {
      const view = await this.toMatchView(match);
      if (!bucket || view.bucket === bucket) {
        views.push(view);
      }
    }
    views.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt));
    return views;
  }

  async getMatch(id: string): Promise<MatchView | null> {
    const match = await this.store.getMatch(id);
    if (!match) {
      return null;
    }
    return this.toMatchView(match);
  }

  async getSquad(matchId: string): Promise<SquadRecord[] | null> {
    const match = await this.store.getMatch(matchId);
    if (!match) {
      return null;
    }
    return this.store.listSquad(matchId);
  }

  async getPlayerPool(matchId: string): Promise<PlayerView[] | null> {
    const match = await this.store.getMatch(matchId);
    if (!match) {
      return null;
    }
    const rows = await this.enrichedSquad(matchId);
    const players = await this.store.listPlayers();
    const pool = getMatchPlayerPool(players, rows);
    const clubs = new Map<string, string>();
    for (const row of rows) {
      const club = await this.store.getClub(row.clubId);
      if (club) {
        clubs.set(club.id, club.name);
      }
    }
    return pool.map((player) => ({
      playerId: player.playerId,
      displayName: player.displayName,
      shortName: player.shortName,
      position: player.position,
      clubId: player.clubId,
      clubName: clubs.get(player.clubId) ?? "",
      credit: player.credit,
      availability: player.availability,
      startingStatus: player.startingStatus,
      squadStatus: "INCLUDED",
    }));
  }

  async playersByPosition(matchId: string, position: PlayerRole): Promise<PlayerView[] | null> {
    const pool = await this.getPlayerPool(matchId);
    if (!pool) {
      return null;
    }
    const ids = new Set(getPlayersByPosition(
      pool.map((player) => ({
        playerId: player.playerId,
        clubId: player.clubId,
        position: player.position,
        credit: player.credit,
        displayName: player.displayName,
        shortName: player.shortName,
        availability: player.availability,
        startingStatus: player.startingStatus,
        active: true,
      })),
      position,
    ).map((player) => player.playerId));
    return pool.filter((player) => ids.has(player.playerId));
  }

  async isEligible(matchId: string, playerId: string): Promise<boolean> {
    const players = await this.store.listPlayers();
    const squad = await this.store.listSquad(matchId);
    const player = players.find((row) => row.id === playerId) ?? null;
    const row = squad.find((squadRow) => squadRow.playerId === playerId) ?? null;
    return isPlayerEligibleForMatch(player, row);
  }

  async createTeam(accountId: string, matchId: string, ctx: RequestContext): Promise<FantasyTeamRecord> {
    const match = await this.requireOpenMatch(matchId);
    const team: FantasyTeamRecord = {
      id: newId(),
      accountId,
      matchId: match.id,
      status: "DRAFT",
      createdAt: ctx.now.toISOString(),
      updatedAt: ctx.now.toISOString(),
    };
    await this.store.createTeam(team);
    return team;
  }

  async getTeamForAccount(teamId: string, accountId: string): Promise<{
    team: FantasyTeamRecord;
    latest: FantasyTeamVersionRecord | null;
  } | null> {
    const team = await this.store.getTeam(teamId);
    if (!team || team.accountId !== accountId) {
      return null;
    }
    const versions = await this.store.listVersions(teamId);
    return { team, latest: versions.at(-1) ?? null };
  }

  async getVersionById(versionId: string): Promise<{
    team: FantasyTeamRecord;
    version: FantasyTeamVersionRecord;
  } | null> {
    return this.store.getVersionById(versionId);
  }

  async getVersionForAccount(versionId: string, accountId: string): Promise<{
    team: FantasyTeamRecord;
    version: FantasyTeamVersionRecord;
  } | null> {
    const owned = await this.store.getVersionById(versionId);
    if (!owned || owned.team.accountId !== accountId) {
      return null;
    }
    return owned;
  }

  async listVersions(teamId: string, accountId: string): Promise<FantasyTeamVersionRecord[] | null> {
    const owned = await this.getTeamForAccount(teamId, accountId);
    if (!owned) {
      return null;
    }
    return this.store.listVersions(teamId);
  }

  async saveVersion(
    teamId: string,
    accountId: string,
    input: { playerIds: string[]; captainId: string; viceId: string },
    ctx: RequestContext,
  ): Promise<FantasyTeamVersionRecord> {
    const team = await this.store.getTeam(teamId);
    if (!team || team.accountId !== accountId) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    if (team.status === "LOCKED") {
      throw new AppError("TEAM_LOCKED", 409, "Locked team cannot be modified");
    }
    const match = await this.requireOpenMatch(team.matchId);
    const pool = await this.pickPool(match.id);
    const result = validateFantasyTeam(
      input,
      pool,
      match.homeClubId,
      match.awayClubId,
      this.rules,
    );
    if (!result.valid) {
      throw new AppError("FANTASY_TEAM_INVALID", 400, "Fantasy team is invalid", { details: result });
    }
    const creditsUsed = calculateCreditsUsed(
      input.playerIds.map((id) => pool.find((player) => player.playerId === id)?.credit ?? 0),
    );
    const versions = await this.store.listVersions(teamId);
    const validationResult: TeamValidationResult & { valid: true; errors: [] } = {
      valid: true,
      errors: [],
    };
    const version: FantasyTeamVersionRecord = {
      id: newId(),
      teamId,
      version: versions.length + 1,
      matchId: match.id,
      playerIds: [...input.playerIds],
      captainId: input.captainId,
      viceId: input.viceId,
      creditsUsed,
      validationResult,
      createdAt: ctx.now.toISOString(),
    };
    await this.store.insertVersion(version);
    await this.audit.append({
      action: "TEAM_SAVED",
      occurredAt: ctx.now,
      entityType: "FANTASY_TEAM",
      entityId: team.id,
      metadata: {
        version: version.version,
        matchId: match.id,
        creditsUsed,
      },
      actorAccountId: accountId,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });
    return version;
  }

  /**
   * Persists a legal DRAFT → LOCKED edge. No HTTP route.
   * TODO: automatic lock at kickoff is not implemented.
   */
  async lockTeam(teamId: string, accountId: string, ctx: RequestContext): Promise<FantasyTeamRecord> {
    const team = await this.store.getTeam(teamId);
    if (!team || team.accountId !== accountId) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    const next = transition("TEAM", team.status, "LOCKED") as TeamState;
    const updated: FantasyTeamRecord = { ...team, status: next, updatedAt: ctx.now.toISOString() };
    await this.store.saveTeam(updated);
    return updated;
  }

  async applyMatchTransition(matchId: string, to: MatchState, ctx: RequestContext): Promise<MatchRecord> {
    return this.store.applyMatchTransition(matchId, to, ctx.now);
  }

  rulesView(): FantasyRules {
    return this.rules;
  }

  private async requireOpenMatch(matchId: string): Promise<MatchRecord> {
    const match = await this.store.getMatch(matchId);
    if (!match) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    if (!canBuildXi(match.status, match.lineupAvailable)) {
      throw new AppError("MATCH_NOT_OPEN", 409, "This match is not open for team changes");
    }
    return match;
  }

  private async pickPool(matchId: string) {
    const rows = await this.enrichedSquad(matchId);
    const players = await this.store.listPlayers();
    return getMatchPlayerPool(players, rows).map((player) => ({
      playerId: player.playerId,
      clubId: player.clubId,
      position: player.position,
      credit: player.credit,
    }));
  }

  private async enrichedSquad(matchId: string): Promise<Array<SquadRecord & PlayerRecord & { creditValue: number }>> {
    const squad = await this.store.listSquad(matchId);
    const players = await this.store.listPlayers();
    const byId = new Map(players.map((player) => [player.id, player]));
    return squad.map((row) => {
      const player = byId.get(row.playerId);
      return {
        ...row,
        id: player?.id ?? row.playerId,
        displayName: player?.displayName ?? "",
        shortName: player?.shortName ?? "",
        position: player?.position ?? row.fantasyPosition,
        clubId: row.clubId,
        active: player?.active ?? false,
        providerId: player?.providerId ?? row.providerId,
        creditValue: row.creditValue,
      };
    });
  }

  private async toMatchView(match: MatchRecord): Promise<MatchView> {
    const home = await this.store.getClub(match.homeClubId);
    const away = await this.store.getClub(match.awayClubId);
    if (!home || !away) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return {
      id: match.id,
      competition: match.competition,
      kickoffAt: match.kickoffAt,
      status: match.status,
      venue: match.venue,
      lineupAvailable: match.lineupAvailable,
      canBuildXi: canBuildXi(match.status, match.lineupAvailable),
      bucket: matchBucket(match.status),
      externalFixtureId: match.externalFixtureId,
      dataSource: match.dataSource,
      home: { id: home.id, name: home.name, shortName: home.shortName },
      away: { id: away.id, name: away.name, shortName: away.shortName },
    };
  }
}
