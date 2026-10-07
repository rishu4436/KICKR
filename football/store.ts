import type { PlayerRole } from "../domain/football/roles.js";
import { transition } from "../domain/state-machine.js";
import type { MatchState, TeamState } from "../domain/state-machine.js";
import type { ScoringEventType } from "../domain/scoring/events.js";
import type { SportsCatalog } from "../sports/types.js";

export interface ClubRecord {
  id: string;
  name: string;
  shortName: string;
  providerId: string;
}

export interface PlayerRecord {
  id: string;
  displayName: string;
  shortName: string;
  position: PlayerRole;
  clubId: string;
  active: boolean;
  providerId: string;
}

export interface MatchRecord {
  id: string;
  homeClubId: string;
  awayClubId: string;
  kickoffAt: string;
  competition: string;
  venue: string | null;
  externalFixtureId: string;
  status: MatchState;
  lineupAvailable: boolean;
  dataSource: { provider: string; label: string; fetchedAt: string; provenance?: string };
}

export interface SquadRecord {
  id: string;
  matchId: string;
  playerId: string;
  clubId: string;
  fantasyPosition: PlayerRole;
  creditValue: number;
  availability: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  startingStatus: "STARTER" | "BENCH" | "UNKNOWN";
  squadStatus: "INCLUDED" | "EXCLUDED";
  providerId: string;
  sourceVersion: string;
  sourcedAt: string;
}

export interface FantasyTeamRecord {
  id: string;
  accountId: string;
  matchId: string;
  status: TeamState;
  createdAt: string;
  updatedAt: string;
}

export interface FantasyTeamVersionRecord {
  id: string;
  teamId: string;
  version: number;
  matchId: string;
  playerIds: string[];
  captainId: string;
  viceId: string;
  creditsUsed: number;
  validationResult: { valid: true; errors: [] };
  createdAt: string;
}

export interface StoredMatchEvent {
  eventId: string;
  matchId: string;
  provider: string;
  providerEventId: string;
  sequence: number;
  timestamp: string;
  matchMinute: number | null;
  period: string | null;
  eventType: ScoringEventType;
  primaryPlayerId: string | null;
  secondaryPlayerId: string | null;
  teamId: string | null;
  metadata: Record<string, unknown>;
  supersedesEventId: string | null;
  createdAt: string;
  correctionType?: "VAR_REVERSAL" | "PROVIDER_CORRECTION" | "SUPERSEDE" | null;
  providerVersion?: string | null;
  rawEventHash?: string | null;
}

export interface FootballStore {
  listMatches(): Promise<MatchRecord[]>;
  getMatch(id: string): Promise<MatchRecord | null>;
  getClub(id: string): Promise<ClubRecord | null>;
  listPlayers(): Promise<PlayerRecord[]>;
  listSquad(matchId: string): Promise<SquadRecord[]>;
  applyMatchTransition(id: string, to: MatchState, now: Date): Promise<MatchRecord>;
  createTeam(team: FantasyTeamRecord): Promise<void>;
  getTeam(id: string): Promise<FantasyTeamRecord | null>;
  saveTeam(team: FantasyTeamRecord): Promise<void>;
  listVersions(teamId: string): Promise<FantasyTeamVersionRecord[]>;
  getVersionById(id: string): Promise<{ version: FantasyTeamVersionRecord; team: FantasyTeamRecord } | null>;
  insertVersion(version: FantasyTeamVersionRecord): Promise<void>;
  listEvents(matchId: string): Promise<StoredMatchEvent[]>;
  insertEvent(event: StoredMatchEvent): Promise<"inserted" | "duplicate">;
  findEventByProvider(provider: string, providerEventId: string): Promise<StoredMatchEvent | null>;
  listTeamsByMatch(matchId: string): Promise<FantasyTeamRecord[]>;
  upsertSquadRow(row: SquadRecord): Promise<void>;
  upsertCatalog(catalog: SportsCatalog): Promise<void>;
  /**
   * Tutorial-only: reset a DEMO match to LINEUPS_AVAILABLE and clear its events.
   * Refuses non-demo providers. Optional — PG + memory implement; callers guard.
   */
  resetTutorialMatch?(matchId: string, catalog: SportsCatalog): Promise<void>;
  /** Phase 18D.2 Match Ops mutations (operator-managed fixtures only). */
  upsertClub?(club: ClubRecord): Promise<void>;
  upsertPlayer?(player: PlayerRecord): Promise<void>;
  upsertMatch?(match: MatchRecord): Promise<void>;
  updateMatchFields?(
    id: string,
    patch: Partial<Pick<MatchRecord, "competition" | "venue" | "kickoffAt" | "status" | "lineupAvailable" | "dataSource" | "homeClubId" | "awayClubId">>,
  ): Promise<MatchRecord>;
}


function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryFootballStore implements FootballStore {
  private matches: MatchRecord[];
  private clubs: ClubRecord[];
  private players: PlayerRecord[];
  private squad: SquadRecord[];
  private events: StoredMatchEvent[];
  private teams = new Map<string, FantasyTeamRecord>();
  private versions: FantasyTeamVersionRecord[] = [];

  constructor(catalog?: SportsCatalog) {
    this.matches = [];
    this.clubs = [];
    this.players = [];
    this.squad = [];
    this.events = [];
    if (catalog) {
      this.load(catalog);
    }
  }

  private load(catalog: SportsCatalog): void {
    this.clubs = catalog.clubs.map((club) => ({ ...club }));
    this.players = catalog.players.map((player) => ({ ...player }));
    this.matches = catalog.matches.map((match) => ({
      ...match,
      dataSource: { ...match.dataSource },
    }));
    this.squad = catalog.squad.map((row) => ({ ...row }));
    this.events = catalog.events.map((event) => ({ ...event, metadata: { ...event.metadata } }));
  }

  async upsertCatalog(catalog: SportsCatalog): Promise<void> {
    this.load(catalog);
  }

  async listMatches(): Promise<MatchRecord[]> {
    return this.matches.map((match) => clone(match));
  }

  async getMatch(id: string): Promise<MatchRecord | null> {
    const match = this.matches.find((row) => row.id === id);
    return match ? clone(match) : null;
  }

  async getClub(id: string): Promise<ClubRecord | null> {
    const club = this.clubs.find((row) => row.id === id);
    return club ? { ...club } : null;
  }

  async listPlayers(): Promise<PlayerRecord[]> {
    return this.players.map((player) => ({ ...player }));
  }

  async listSquad(matchId: string): Promise<SquadRecord[]> {
    return this.squad.filter((row) => row.matchId === matchId).map((row) => ({ ...row }));
  }

  async applyMatchTransition(id: string, to: MatchState, now: Date): Promise<MatchRecord> {
    const match = this.matches.find((row) => row.id === id);
    if (!match) {
      throw new Error("match not found");
    }
    match.status = transition("MATCH", match.status, to) as MatchState;
    void now;
    return clone(match);
  }

  async createTeam(team: FantasyTeamRecord): Promise<void> {
    this.teams.set(team.id, { ...team });
  }

  async getTeam(id: string): Promise<FantasyTeamRecord | null> {
    const team = this.teams.get(id);
    return team ? { ...team } : null;
  }

  async saveTeam(team: FantasyTeamRecord): Promise<void> {
    if (!this.teams.has(team.id)) {
      throw new Error("team not found");
    }
    this.teams.set(team.id, { ...team });
  }

  async listVersions(teamId: string): Promise<FantasyTeamVersionRecord[]> {
    return this.versions
      .filter((version) => version.teamId === teamId)
      .slice()
      .sort((a, b) => a.version - b.version)
      .map((version) => clone(version));
  }

  async getVersionById(id: string): Promise<{ version: FantasyTeamVersionRecord; team: FantasyTeamRecord } | null> {
    const version = this.versions.find((row) => row.id === id);
    if (!version) {
      return null;
    }
    const team = this.teams.get(version.teamId);
    if (!team) {
      return null;
    }
    return { version: clone(version), team: { ...team } };
  }

  async insertVersion(version: FantasyTeamVersionRecord): Promise<void> {
    this.versions.push(clone(version));
  }

  async listEvents(matchId: string): Promise<StoredMatchEvent[]> {
    return this.events.filter((event) => event.matchId === matchId).map((event) => clone(event));
  }

  async insertEvent(event: StoredMatchEvent): Promise<"inserted" | "duplicate"> {
    const exists = this.events.some(
      (row) => row.provider === event.provider && row.providerEventId === event.providerEventId,
    );
    if (exists) {
      return "duplicate";
    }
    this.events.push(clone(event));
    return "inserted";
  }

  async findEventByProvider(provider: string, providerEventId: string): Promise<StoredMatchEvent | null> {
    const event = this.events.find(
      (row) => row.provider === provider && row.providerEventId === providerEventId,
    );
    return event ? clone(event) : null;
  }

  async listTeamsByMatch(matchId: string): Promise<FantasyTeamRecord[]> {
    return [...this.teams.values()].filter((team) => team.matchId === matchId).map((team) => ({ ...team }));
  }

  async upsertSquadRow(row: SquadRecord): Promise<void> {
    const index = this.squad.findIndex(
      (item) => item.matchId === row.matchId && item.playerId === row.playerId,
    );
    if (index >= 0) {
      this.squad[index] = clone(row);
    } else {
      this.squad.push(clone(row));
    }
  }

  async upsertClub(club: ClubRecord): Promise<void> {
    const index = this.clubs.findIndex((row) => row.id === club.id);
    if (index >= 0) this.clubs[index] = { ...club };
    else this.clubs.push({ ...club });
  }

  async upsertPlayer(player: PlayerRecord): Promise<void> {
    const index = this.players.findIndex((row) => row.id === player.id);
    if (index >= 0) this.players[index] = { ...player };
    else this.players.push({ ...player });
  }

  async upsertMatch(match: MatchRecord): Promise<void> {
    const index = this.matches.findIndex((row) => row.id === match.id);
    const copy = { ...match, dataSource: { ...match.dataSource } };
    if (index >= 0) this.matches[index] = copy;
    else this.matches.push(copy);
  }

  async updateMatchFields(
    id: string,
    patch: Partial<Pick<MatchRecord, "competition" | "venue" | "kickoffAt" | "status" | "lineupAvailable" | "dataSource" | "homeClubId" | "awayClubId">>,
  ): Promise<MatchRecord> {
    const match = this.matches.find((row) => row.id === id);
    if (!match) throw new Error("match not found");
    if (patch.competition !== undefined) match.competition = patch.competition;
    if (patch.venue !== undefined) match.venue = patch.venue;
    if (patch.kickoffAt !== undefined) match.kickoffAt = patch.kickoffAt;
    if (patch.status !== undefined) match.status = patch.status;
    if (patch.lineupAvailable !== undefined) match.lineupAvailable = patch.lineupAvailable;
    if (patch.homeClubId !== undefined) match.homeClubId = patch.homeClubId;
    if (patch.awayClubId !== undefined) match.awayClubId = patch.awayClubId;
    if (patch.dataSource !== undefined) match.dataSource = { ...patch.dataSource };
    return clone(match);
  }

  async resetTutorialMatch(matchId: string, catalog: SportsCatalog): Promise<void> {
    const match = this.matches.find((row) => row.id === matchId);
    if (!match) {
      throw new Error("match not found");
    }
    if (match.dataSource.provider !== "demo") {
      throw new Error("resetTutorialMatch refuses non-demo matches");
    }
    this.clubs = catalog.clubs.map((club) => ({ ...club }));
    this.players = catalog.players.map((player) => ({ ...player }));
    const fromCatalog = catalog.matches.find((m) => m.id === matchId);
    match.status = (fromCatalog?.status ?? "LINEUPS_AVAILABLE") as MatchState;
    match.lineupAvailable = true;
    match.competition = fromCatalog?.competition ?? match.competition;
    match.venue = fromCatalog?.venue ?? match.venue;
    match.dataSource = { ...(fromCatalog?.dataSource ?? match.dataSource) };
    this.squad = [
      ...this.squad.filter((row) => row.matchId !== matchId),
      ...catalog.squad.filter((row) => row.matchId === matchId).map((row) => ({ ...row })),
    ];
    this.events = this.events.filter((event) => event.matchId !== matchId);
  }
}

export function updateFantasyTeamVersion(): never {
  throw new Error("fantasy team versions are append-only");
}

export function updateMatchEvent(): never {
  throw new Error("match events are append-only");
}
