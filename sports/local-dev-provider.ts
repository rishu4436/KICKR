import type { PlayerRole } from "../domain/football/roles.js";
import type { ProviderEvent, ProviderPlayer, ProviderSquadRow, SportsCatalog, SportsDataProvider } from "./types.js";

/**
 * Deterministic development catalog. Not a live sports feed.
 * Clubs are fictional. Do not treat scores or squads as production data.
 */

const SOURCE = {
  provider: "local-dev",
  label: "DEMO / LOCAL_DEV fictional data — not Sportmonks, not a live feed",
  fetchedAt: "2026-10-01T00:00:00.000Z",
};

/** Believable fictional names. shortName stays A/B codes for test selectors. */
const DEMO_NAMES_A: Record<string, string[]> = {
  GK: ["Jonah Pike", "Ellis Crowe"],
  DEF: ["Mateo Rivas", "Owen Brandt", "Kai Okonkwo", "Felix Dunn", "Arjun Mehta"],
  MID: ["Luca Varela", "Noah Kessler", "Ibrahim Diallo", "Theo March", "Soren Blake"],
  FWD: ["Rafael Costa", "Milo Hart", "Yusuf Kamara", "Finn Aldridge"],
};
const DEMO_NAMES_B: Record<string, string[]> = {
  GK: ["Hugo Lennox", "Pavel Orth"],
  DEF: ["Diego Marquez", "Callum Frost", "Kenji Sato", "Bruno Almeida", "Nils Berger"],
  MID: ["Enzo Ricci", "Jamal Pierce", "Victor Holm", "Omar Farid", "Sean Quinn"],
  FWD: ["Andre Silva", "Leo Navarro", "Chris Patton", "Darius Cole"],
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
  const names = label === "A" ? DEMO_NAMES_A : DEMO_NAMES_B;
  const players: ProviderPlayer[] = [];
  let index = 1;
  for (const group of ROLE_PLAN) {
    for (let n = 0; n < group.count; n += 1) {
      const id = playerId(club, index);
      const displayName = names[group.role]?.[n] ?? `${label} ${group.role} ${n + 1}`;
      players.push({
        id,
        displayName,
        // Keep AF1 / BM2 short codes so existing tests and XI pickers stay stable.
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
  // Keep FWD1 premium; others flat so classic XI fixtures stay at 99 credits.
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
      competition: "DEMO Cup (LOCAL_DEV)",
      venue: "DEMO Pitch — fictional",
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
      competition: "DEMO Cup (LOCAL_DEV)",
      venue: "DEMO Pitch — fictional",
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
      competition: "DEMO Cup (LOCAL_DEV)",
      venue: null,
      externalFixtureId: "dev-fixture-final",
      status: "FINAL" as const,
      lineupAvailable: true,
      dataSource: SOURCE,
    },
  ];
  return {
    clubs: [
      { id: LOCAL_DEV_CLUB_A, name: "Northbridge FC", shortName: "NBF", providerId: "dev-club-a" },
      { id: LOCAL_DEV_CLUB_B, name: "Riverdale United", shortName: "RVU", providerId: "dev-club-b" },
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
  if (name === "unset" || name === "" || name === "none") {
    return null;
  }
  if (name === "local-dev") {
    return createLocalDevProvider();
  }
  // demo is created via sports/demo-provider (factory). Do not silent-fallback here.
  throw new Error(
    `Unknown SPORTS_DATA_PROVIDER "${name}". Allowed: local-dev, unset. For DEMO use SPORTS_PROVIDER=DEMO (see sports/factory.ts).`,
  );
}

/**
 * Build a fresh LOCAL_DEV match bundle at LINEUPS_AVAILABLE with diverse events.
 * Used by the free E2E harness so lifecycle advances forward-only (no reverse edges).
 * Explicitly marked LOCAL_DEV — never Sportmonks.
 */
export function buildEphemeralLocalDevMatch(seed = Date.now()): {
  matchId: string;
  catalog: SportsCatalog;
  label: string;
} {
  const base = buildLocalDevCatalog();
  const hex = seed.toString(16).padStart(12, "0").slice(-12);
  const matchId = `10000000-0000-4000-8000-${hex}`;
  const label = `LOCAL_DEV E2E ${hex.slice(-6)}`;
  const kickoffAt = new Date(Date.now() + 3_600_000).toISOString();
  const match = {
    id: matchId,
    homeClubId: LOCAL_DEV_CLUB_A,
    awayClubId: LOCAL_DEV_CLUB_B,
    kickoffAt,
    competition: "DEMO Cup E2E (LOCAL_DEV)",
    venue: "DEMO Pitch — fictional",
    externalFixtureId: `dev-e2e-${hex}`,
    status: "LINEUPS_AVAILABLE" as const,
    lineupAvailable: true,
    dataSource: {
      provider: "local-dev",
      label: "LOCAL_DEV ephemeral E2E match, not a live feed, not Sportmonks",
      fetchedAt: new Date().toISOString(),
    },
  };
  const players = base.players;
  const squad = players.map((player, index) => ({
    id: `58000000-0000-4000-8000-${hex.slice(-4)}${String(index + 1).padStart(8, "0")}`,
    matchId,
    playerId: player.id,
    clubId: player.clubId,
    fantasyPosition: player.position,
    creditValue: creditFor(player),
    availability: "AVAILABLE" as const,
    startingStatus: index < 11 ? ("STARTER" as const) : ("BENCH" as const),
    squadStatus: "INCLUDED" as const,
    providerId: `dev-e2e-squad-${player.providerId}-${hex}`,
    sourceVersion: `dev-e2e-${hex}`,
    sourcedAt: match.dataSource.fetchedAt,
  }));
  // Start with the live wave so a later append of late events changes ranks.
  const template = sampleEvents(LOCAL_DEV_MATCH_LIVE, "live");
  const events = remapEventsOntoMatch(template, matchId, hex, 1);
  return {
    matchId,
    label,
    catalog: {
      clubs: base.clubs,
      players: base.players,
      matches: [match],
      squad,
      events,
    },
  };
}

function remapEventsOntoMatch(
  template: ProviderEvent[],
  matchId: string,
  hex: string,
  seqOffset: number,
): ProviderEvent[] {
  // Use 8xxxxxxx UUID prefix so ephemeral ids never collide with static 6/7xxxxxxx catalog events.
  return template.map((event, i) => ({
    ...event,
    matchId,
    sequence: seqOffset + i,
    eventId: `80000000-0000-4000-8000-${hex.slice(-4)}${String(seqOffset + i).padStart(8, "0")}`,
    providerEventId: `dev-e2e-${hex}-evt-${seqOffset + i}`,
    metadata: {
      ...event.metadata,
      label: "development event, not a live feed",
      source: "local-dev",
      notSportmonks: true,
      ephemeralMatchId: matchId,
    },
  }));
}

/** Late LOCAL_DEV events for an ephemeral match — appending changes live ranks. */
export function buildLateLocalDevEvents(matchId: string, seedHex?: string): ProviderEvent[] {
  const hex = (seedHex ?? matchId.slice(-12)).padStart(12, "0").slice(-12);
  const full = sampleEvents(LOCAL_DEV_MATCH_FINAL, "final");
  const live = sampleEvents(LOCAL_DEV_MATCH_LIVE, "live");
  const late = full.slice(live.length);
  return remapEventsOntoMatch(late, matchId, hex, live.length + 1);
}

/**
 * XI variant picker tuned so different captains on LOCAL_DEV scorers produce
 * visibly distinct fantasy totals (goals / assists on A FWD2, B FWD2, A MID2).
 */
export function pickDiverseLocalDevXi(
  players: Array<{ playerId: string; position: string; clubId: string; shortName?: string }>,
  variant: number,
): { playerIds: string[]; captainId: string; viceId: string } {
  const home = players[0]?.clubId ?? "";
  const away = players.find((p) => p.clubId !== home)?.clubId ?? "";
  const byPosClub = (pos: string, clubId: string) =>
    players.filter((p) => p.position === pos && p.clubId === clubId);
  const take = (pos: string, clubId: string, nth: number) => {
    const row = byPosClub(pos, clubId)[nth];
    if (!row) throw new Error(`LOCAL_DEV pool missing ${pos} #${nth}`);
    return row.playerId;
  };
  const findByShort = (prefix: string, role: string, n: number) => {
    const hit = players.find(
      (p) =>
        p.position === role &&
        (p.shortName?.startsWith(prefix) ?? false) &&
        (p.shortName?.endsWith(String(n)) ?? false),
    );
    return hit?.playerId;
  };
  const aFwd2 = findByShort("A", "FWD", 2) ?? take("FWD", home, 1);
  const bFwd2 = findByShort("B", "FWD", 2) ?? take("FWD", away, 1);
  const aMid2 = findByShort("A", "MID", 2) ?? take("MID", home, 1);
  const bMid2 = findByShort("B", "MID", 2) ?? take("MID", away, 1);
  const aMid1 = findByShort("A", "MID", 1) ?? take("MID", home, 0);
  const bMid1 = findByShort("B", "MID", 1) ?? take("MID", away, 0);

  const cores = [
    {
      playerIds: [
        take("GK", home, 0),
        take("DEF", home, 0),
        take("DEF", home, 1),
        take("DEF", home, 2),
        take("DEF", home, 3),
        aMid1,
        aMid2,
        bMid1,
        take("DEF", away, 0),
        aFwd2,
        bFwd2,
      ],
      captainId: aFwd2,
      viceId: aMid2,
    },
    {
      playerIds: [
        take("GK", home, 0),
        take("DEF", home, 0),
        take("DEF", home, 1),
        take("DEF", home, 2),
        take("DEF", away, 1),
        aMid1,
        bMid2,
        bMid1,
        take("DEF", away, 0),
        aFwd2,
        bFwd2,
      ],
      captainId: bFwd2,
      viceId: bMid2,
    },
    {
      playerIds: [
        take("GK", away, 0),
        take("DEF", home, 0),
        take("DEF", home, 1),
        take("DEF", away, 0),
        take("DEF", away, 1),
        aMid2,
        bMid1,
        bMid2,
        take("DEF", home, 2),
        aFwd2,
        take("FWD", away, 2), // FWD3 = 9cr (avoid FWD1 15cr)
      ],
      captainId: aMid2,
      viceId: aFwd2,
    },
    {
      playerIds: [
        take("GK", home, 0),
        take("DEF", home, 0),
        take("DEF", home, 1),
        take("DEF", home, 2),
        take("DEF", home, 3),
        aMid1,
        aMid2,
        bMid2,
        take("DEF", away, 2),
        take("FWD", home, 2), // FWD3 = 9cr (avoid FWD1 15cr)
        bFwd2,
      ],
      captainId: bMid2,
      viceId: bFwd2,
    },
  ];
  return cores[variant % cores.length]!;
}
