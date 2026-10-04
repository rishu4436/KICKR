import type { PlayerRole } from "../domain/football/roles.js";
import type { MatchState } from "../domain/state-machine.js";
import type { ScoringEventType } from "../domain/scoring/events.js";

/**
 * Sports data port. Implementations may be local-dev or a future provider.
 * Domain tables keep internal ids. Provider ids are references only.
 */

export interface ProviderClub {
  id: string;
  name: string;
  shortName: string;
  providerId: string;
}

export interface ProviderPlayer {
  id: string;
  displayName: string;
  shortName: string;
  position: PlayerRole;
  clubId: string;
  active: boolean;
  providerId: string;
}

export interface ProviderMatch {
  id: string;
  homeClubId: string;
  awayClubId: string;
  kickoffAt: string;
  competition: string;
  venue: string | null;
  externalFixtureId: string;
  status: MatchState;
  lineupAvailable: boolean;
  dataSource: {
    provider: string;
    label: string;
    fetchedAt: string;
  };
}

export interface ProviderSquadRow {
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

export interface ProviderEvent {
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
}

export interface SportsCatalog {
  clubs: ProviderClub[];
  players: ProviderPlayer[];
  matches: ProviderMatch[];
  squad: ProviderSquadRow[];
  events: ProviderEvent[];
}

export interface SportsDataProvider {
  readonly name: string;
  /** True only for non-production development feeds. */
  readonly developmentOnly: boolean;
  listMatches(): Promise<ProviderMatch[]>;
  getMatch(id: string): Promise<ProviderMatch | null>;
  getSquad(matchId: string): Promise<ProviderSquadRow[]>;
  getEvents(matchId: string): Promise<ProviderEvent[]>;
  catalog(): SportsCatalog;
}
