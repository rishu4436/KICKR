/**
 * Explicit DEMO sports catalog — fictional clubs/players only.
 * Safe for production demo deployments. Never claims Sportmonks or real-world data.
 * Separate from LOCAL_DEV (developer machines only).
 */
import type { SportsCatalog, SportsDataProvider, ProviderEvent, ProviderMatch } from "./types.js";
import {
  buildLocalDevCatalog,
  LOCAL_DEV_CLUB_A,
  LOCAL_DEV_CLUB_B,
  LOCAL_DEV_MATCH_UPCOMING,
  LOCAL_DEV_MATCH_LIVE,
  LOCAL_DEV_MATCH_FINAL,
} from "./local-dev-provider.js";

export const DEMO_PROVIDER_NAME = "demo";

export const DEMO_CLUB_A = LOCAL_DEV_CLUB_A;
export const DEMO_CLUB_B = LOCAL_DEV_CLUB_B;
export const DEMO_MATCH_UPCOMING = LOCAL_DEV_MATCH_UPCOMING;
export const DEMO_MATCH_LIVE = LOCAL_DEV_MATCH_LIVE;
export const DEMO_MATCH_FINAL = LOCAL_DEV_MATCH_FINAL;

const DEMO_SOURCE = {
  provider: DEMO_PROVIDER_NAME,
  label: "DEMO DATA — fictional clubs/players, not Sportmonks, not a live feed",
  fetchedAt: "2026-10-01T00:00:00.000Z",
};

function remapEvent(event: ProviderEvent): ProviderEvent {
  return {
    ...event,
    provider: DEMO_PROVIDER_NAME,
    metadata: {
      ...event.metadata,
      label: "DEMO DATA event — fictional, not a live feed",
      source: DEMO_PROVIDER_NAME,
      notSportmonks: true,
      demoData: true,
    },
  };
}

function remapMatch(match: ProviderMatch): ProviderMatch {
  return {
    ...match,
    competition: match.competition.replace(/LOCAL_DEV/g, "DEMO").replace(/DEMO Cup \(DEMO\)/, "DEMO Cup"),
    venue: match.venue?.includes("fictional") ? match.venue : "DEMO Pitch — fictional",
    dataSource: { ...DEMO_SOURCE, fetchedAt: match.dataSource.fetchedAt },
  };
}

/** Deterministic DEMO catalog (upcoming → live → final). Fictional only. */
export function buildDemoCatalog(): SportsCatalog {
  const base = buildLocalDevCatalog();
  return {
    clubs: base.clubs.map((c) => ({
      ...c,
      providerId: c.providerId.replace(/^dev-/, "demo-"),
    })),
    players: base.players.map((p) => ({
      ...p,
      providerId: p.providerId.replace(/^dev-/, "demo-"),
    })),
    matches: base.matches.map(remapMatch).map((m) => ({
      ...m,
      competition: "DEMO Cup",
      dataSource: DEMO_SOURCE,
    })),
    squad: base.squad.map((row) => ({
      ...row,
      providerId: row.providerId.replace(/^dev-/, "demo-"),
      sourceVersion: "demo-1",
    })),
    events: base.events.map(remapEvent),
  };
}

export function createDemoProvider(): SportsDataProvider {
  const data = buildDemoCatalog();
  return {
    name: DEMO_PROVIDER_NAME,
    /** False: DEMO is allowed in production demo deployments (unlike local-dev). */
    developmentOnly: false,
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

export function isDemoProviderName(name: string): boolean {
  const n = name.trim().toLowerCase().replace(/_/g, "-");
  return n === "demo";
}
