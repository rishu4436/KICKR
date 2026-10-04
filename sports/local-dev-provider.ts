import type { PlayerRole } from "../domain/football/roles.js";
import type { ProviderEvent, ProviderPlayer, ProviderSquadRow, SportsCatalog, SportsDataProvider } from "./types.js";

/**
 * Deterministic development catalog. Not a live sports feed.
 * Clubs are fictional. Do not treat scores or squads as production data.
 */

const SOURCE = {
  provider: "local-dev",
  label: "development data, not a live feed",
  fetchedAt: "2026-10-01T00:00:00.000Z",
};

export const LOCAL_DEV_CLUB_A = "20000000-0000-4000-8000-000000000001";
export const LOCAL_DEV_CLUB_B = "20000000-0000-4000-8000-000000000002";
export const LOCAL_DEV_MATCH_UPCOMING = "10000000-0000-4000-8000-000000000001";
export const LOCAL_DEV_MATCH_LIVE = "10000000-0000-4000-8000-000000000002";
export const LOCAL_DEV_MATCH_FINAL = "10000000-0000-4000-8000-000000000003";

function playerId(club: number, index: number): string {
  return `30000000-0000-4000-8000-${String(club * 100 + index).padStart(12, "0")}`;
}

const ROLE_PLAN: readonly { role: PlayerRole; count: number }[] = [
  { role: "GK", count: 2 },
  { role: "DEF", count: 5 },
  { role: "MID", count: 5 },
  { role: "FWD", count: 4 },
];

function buildPlayers(club: number, clubId: string, label: string): ProviderPlayer[] {
  const players: ProviderPlayer[] = [];
  let index = 1;
  for (const group of ROLE_PLAN) {
    for (let n = 0; n < group.count; n += 1) {
      const id = playerId(club, index);
      players.push({
        id,
        displayName: `${label} ${group.role} ${n + 1}`,
        shortName: `${label}${group.role.slice(0, 1)}${n + 1}`,
        position: group.role,
        clubId,
        active: true,
        providerId: `dev-${label.toLowerCase()}-${index}`,
      });
      index += 1;
    }
  }
  return players;
}

function creditFor(player: ProviderPlayer): number {
  if (player.position === "FWD" && player.shortName.endsWith("1")) {
    return 15;
  }
  return 9;
}

function squadFor(matchId: string, players: readonly ProviderPlayer[], excludedId: string | null): ProviderSquadRow[] {
  return players.map((player, index) => ({
    id: `50000000-0000-4000-8000-${matchId.slice(-4)}${String(index + 1).padStart(8, "0")}`,
    matchId,
    playerId: player.id,
    clubId: player.clubId,
    fantasyPosition: player.position,
    creditValue: creditFor(player),
    availability: "AVAILABLE" as const,
    startingStatus: index < 11 ? "STARTER" as const : "BENCH" as const,
    squadStatus: player.id === excludedId ? "EXCLUDED" as const : "INCLUDED" as const,
    providerId: `dev-squad-${player.providerId}`,
    sourceVersion: "dev-1",
    sourcedAt: SOURCE.fetchedAt,
  }));
}

const playersA = buildPlayers(1, LOCAL_DEV_CLUB_A, "A");
const playersB = buildPlayers(2, LOCAL_DEV_CLUB_B, "B");
const excluded = playersA.find((player) => player.position === "FWD" && player.shortName.endsWith("4"))?.id ?? null;

function sampleEvents(matchId: string): ProviderEvent[] {
  const goal = playersA.find((player) => player.position === "FWD" && player.shortName.endsWith("1"));
  const assist = playersA.find((player) => player.position === "MID" && player.shortName.endsWith("1"));
  const shot = playersA.find((player) => player.position === "MID" && player.shortName.endsWith("2"));
  const yellow = playersB.find((player) => player.position === "DEF" && player.shortName.endsWith("1"));
  const corner = playersB.find((player) => player.position === "MID" && player.shortName.endsWith("1"));
  const off = playersA.find((player) => player.position === "MID" && player.shortName.endsWith("3"));
  const on = playersA.find((player) => player.position === "MID" && player.shortName.endsWith("4"));
  if (!goal || !assist || !shot || !yellow || !corner || !off || !on) {
    throw new Error("local dev catalog is missing sample players");
  }
  const base = {
    matchId,
    provider: "local-dev",
    matchMinute: 20,
    period: "1",
    metadata: { label: "development event, not a live feed" },
    supersedesEventId: null,
    createdAt: "2026-10-01T16:00:00.000Z",
  };
  return [
    {
      ...base,
      eventId: "60000000-0000-4000-8000-000000000001",
      providerEventId: "dev-evt-1",
      sequence: 1,
      timestamp: "2026-10-01T15:20:00.000Z",
      eventType: "GOAL",
      primaryPlayerId: goal.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
    },
    {
      ...base,
      eventId: "60000000-0000-4000-8000-000000000002",
      providerEventId: "dev-evt-2",
      sequence: 2,
      timestamp: "2026-10-01T15:20:00.000Z",
      eventType: "ASSIST",
      primaryPlayerId: assist.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
    },
    {
      ...base,
      eventId: "60000000-0000-4000-8000-000000000003",
      providerEventId: "dev-evt-3",
      sequence: 3,
      timestamp: "2026-10-01T15:25:00.000Z",
      eventType: "SHOT_ON_TARGET",
      primaryPlayerId: shot.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_A,
    },
    {
      ...base,
      eventId: "60000000-0000-4000-8000-000000000004",
      providerEventId: "dev-evt-4",
      sequence: 4,
      timestamp: "2026-10-01T15:40:00.000Z",
      eventType: "YELLOW_CARD",
      primaryPlayerId: yellow.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_B,
    },
    {
      ...base,
      eventId: "60000000-0000-4000-8000-000000000005",
      providerEventId: "dev-evt-5",
      sequence: 5,
      timestamp: "2026-10-01T15:55:00.000Z",
      eventType: "CORNER_WON",
      primaryPlayerId: corner.id,
      secondaryPlayerId: null,
      teamId: LOCAL_DEV_CLUB_B,
    },
    {
      ...base,
      eventId: "60000000-0000-4000-8000-000000000006",
      providerEventId: "dev-evt-6",
      sequence: 6,
      timestamp: "2026-10-01T16:05:00.000Z",
      matchMinute: 60,
      period: "2",
      eventType: "SUBSTITUTION",
      primaryPlayerId: off.id,
      secondaryPlayerId: on.id,
      teamId: LOCAL_DEV_CLUB_A,
    },
  ];
}

export function buildLocalDevCatalog(): SportsCatalog {
  const players = [...playersA, ...playersB];
  const matches = [
    {
      id: LOCAL_DEV_MATCH_UPCOMING,
      homeClubId: LOCAL_DEV_CLUB_A,
      awayClubId: LOCAL_DEV_CLUB_B,
      kickoffAt: "2026-10-10T15:00:00.000Z",
      competition: "DEV Cup",
      venue: "Dev Stadium",
      externalFixtureId: "dev-fixture-upcoming",
      status: "LINEUPS_AVAILABLE" as const,
      lineupAvailable: true,
      dataSource: SOURCE,
    },
    {
      id: LOCAL_DEV_MATCH_LIVE,
      homeClubId: LOCAL_DEV_CLUB_A,
      awayClubId: LOCAL_DEV_CLUB_B,
      kickoffAt: "2026-10-03T12:00:00.000Z",
      competition: "DEV Cup",
      venue: "Dev Stadium",
      externalFixtureId: "dev-fixture-live",
      status: "LIVE" as const,
      lineupAvailable: true,
      dataSource: SOURCE,
    },
    {
      id: LOCAL_DEV_MATCH_FINAL,
      homeClubId: LOCAL_DEV_CLUB_A,
      awayClubId: LOCAL_DEV_CLUB_B,
      kickoffAt: "2026-10-01T15:00:00.000Z",
      competition: "DEV Cup",
      venue: null,
      externalFixtureId: "dev-fixture-final",
      status: "FINAL" as const,
      lineupAvailable: true,
      dataSource: SOURCE,
    },
  ];
  return {
    clubs: [
      { id: LOCAL_DEV_CLUB_A, name: "Team A", shortName: "TMA", providerId: "dev-club-a" },
      { id: LOCAL_DEV_CLUB_B, name: "Team B", shortName: "TMB", providerId: "dev-club-b" },
    ],
    players,
    matches,
    squad: [
      ...squadFor(LOCAL_DEV_MATCH_UPCOMING, players, excluded),
      ...squadFor(LOCAL_DEV_MATCH_LIVE, players, excluded),
      ...squadFor(LOCAL_DEV_MATCH_FINAL, players, excluded),
    ],
    events: sampleEvents(LOCAL_DEV_MATCH_FINAL),
  };
}

export function createLocalDevProvider(): SportsDataProvider {
  const data = buildLocalDevCatalog();
  return {
    name: "local-dev",
    developmentOnly: true,
    catalog: () => data,
    async listMatches() {
      return data.matches;
    },
    async getMatch(id: string) {
      return data.matches.find((match) => match.id === id) ?? null;
    },
    async getSquad(matchId: string) {
      return data.squad.filter((row) => row.matchId === matchId);
    },
    async getEvents(matchId: string) {
      return data.events.filter((event) => event.matchId === matchId);
    },
  };
}

export function createSportsProvider(name: string): SportsDataProvider | null {
  if (name === "unset") {
    return null;
  }
  if (name === "local-dev") {
    return createLocalDevProvider();
  }
  throw new Error(
    `Unknown SPORTS_DATA_PROVIDER "${name}". Phase 2 knows local-dev and unset only. A production feed is not implemented.`,
  );
}
