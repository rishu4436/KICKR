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

/**
 * Local-dev-only scoring timeline. Distinct player hits so captain / XI variants
 * produce visibly different fantasy totals. Never labelled as Sportmonks.
 */
function sampleEvents(matchId: string, wave: "live" | "final"): ProviderEvent[] {
  const aFwd1 = playersA.find((player) => player.position === "FWD" && player.shortName.endsWith("1"));
  const aFwd2 = playersA.find((player) => player.position === "FWD" && player.shortName.endsWith("2"));
  const aMid1 = playersA.find((player) => player.position === "MID" && player.shortName.endsWith("1"));
  const aMid2 = playersA.find((player) => player.position === "MID" && player.shortName.endsWith("2"));
  const aDef1 = playersA.find((player) => player.position === "DEF" && player.shortName.endsWith("1"));
  const bFwd2 = playersB.find((player) => player.position === "FWD" && player.shortName.endsWith("2"));
  const bMid1 = playersB.find((player) => player.position === "MID" && player.shortName.endsWith("1"));
  const bMid2 = playersB.find((player) => player.position === "MID" && player.shortName.endsWith("2"));
  const bDef1 = playersB.find((player) => player.position === "DEF" && player.shortName.endsWith("1"));
  const bDef2 = playersB.find((player) => player.position === "DEF" && player.shortName.endsWith("2"));
  if (!aFwd1 || !aFwd2 || !aMid1 || !aMid2 || !aDef1 || !bFwd2 || !bMid1 || !bMid2 || !bDef1 || !bDef2) {
    throw new Error("local dev catalog is missing sample players");
  }
  const prefix = wave === "live" ? "7" : "6";
  const base = {
    matchId,
    provider: "local-dev",
    period: "1",
    metadata: {
      label: "development event, not a live feed",
      source: "local-dev",
      wave,
      notSportmonks: true,
    },
    supersedesEventId: null,
    createdAt: "2026-10-01T16:00:00.000Z",
  };
  const mk = (
    seq: number,
    minute: number,
    eventType: ProviderEvent["eventType"],
    primary: ProviderPlayer,
    teamId: string,
    secondary: ProviderPlayer | null = null,
  ): ProviderEvent => {
    const day = wave === "live" ? "3" : "1";
    const hours = 15 + Math.floor(minute / 60);
    const mins = minute % 60;
    return {
      ...base,
      eventId: `${prefix}0000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
      providerEventId: `dev-${wave}-evt-${seq}`,
      sequence: seq,
      timestamp: `2026-10-0${day}T${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}:00.000Z`,
      matchMinute: minute,
      period: minute >= 45 ? "2" : "1",
      eventType,
      primaryPlayerId: primary.id,
      secondaryPlayerId: secondary?.id ?? null,
      teamId,
    };
  };

  // Wave order matters for "events arriving over time" demos.
  const early: ProviderEvent[] = [
    mk(1, 8, "SHOT_ON_TARGET", aMid1, LOCAL_DEV_CLUB_A),
    mk(2, 12, "CORNER_WON", bMid1, LOCAL_DEV_CLUB_B),
    mk(3, 18, "GOAL", aFwd2, LOCAL_DEV_CLUB_A),
    mk(4, 18, "ASSIST", aMid2, LOCAL_DEV_CLUB_A),
  ];
  const mid: ProviderEvent[] = [
    mk(5, 33, "YELLOW_CARD", bDef1, LOCAL_DEV_CLUB_B),
    mk(6, 41, "SHOT_ON_TARGET", bFwd2, LOCAL_DEV_CLUB_B),
    mk(7, 44, "GOAL", bFwd2, LOCAL_DEV_CLUB_B),
    mk(8, 44, "ASSIST", bMid2, LOCAL_DEV_CLUB_B),
  ];
  const late: ProviderEvent[] = [
    mk(9, 55, "CORNER_WON", aDef1, LOCAL_DEV_CLUB_A),
    mk(10, 62, "SHOT_ON_TARGET", aMid2, LOCAL_DEV_CLUB_A),
    mk(11, 71, "GOAL", aFwd2, LOCAL_DEV_CLUB_A),
    mk(12, 78, "YELLOW_CARD", bDef2, LOCAL_DEV_CLUB_B),
  ];
  if (wave === "live") {
    // Live match: early + mid only so late events can be appended by seed tooling.
    return [...early, ...mid];
  }
  return [...early, ...mid, ...late];
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
    events: [
      ...sampleEvents(LOCAL_DEV_MATCH_LIVE, "live"),
      ...sampleEvents(LOCAL_DEV_MATCH_FINAL, "final"),
    ],
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
  // Production live adapter is selected via SPORTS_PROVIDER (see sports/factory.ts).
  // Keep Phase 2 boot working for local-dev|unset only on SPORTS_DATA_PROVIDER.
  throw new Error(
    `Unknown SPORTS_DATA_PROVIDER "${name}". Allowed: local-dev, unset. Use SPORTS_PROVIDER=sportmonks for the live adapter.`,
  );
}
