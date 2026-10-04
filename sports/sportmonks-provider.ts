import type { Logger } from "../shared/logger.js";
import type {
  ProviderEvent,
  ProviderMatch,
  ProviderSquadRow,
  SportsCatalog,
  SportsDataProvider,
} from "./types.js";
import { SPORTMONKS_API_VERSION } from "./normalize.js";

/**
 * Sportmonks Football API v3 adapter.
 * Docs: https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/livescores/get-inplay-livescores
 * Base URL default: https://api.sportmonks.com/v3
 *
 * Fails closed when API key/URL are missing. Never invents live production data.
 * Tests must not call the network; use recorded fixtures via normalize.ts.
 */

export const SPORTMONKS_PROVIDER_NAME = "sportmonks";
export const DEFAULT_SPORTMONKS_API_URL = "https://api.sportmonks.com/v3";

export interface SportmonksProviderConfig {
  apiKey: string | null;
  apiUrl: string;
  requestTimeoutMs: number;
  fetchImpl?: typeof fetch;
  logger?: Logger;
}

export class SportmonksNotConfiguredError extends Error {
  constructor(message = "SPORTS_API_KEY is required for the sportmonks live provider") {
    super(message);
    this.name = "SportmonksNotConfiguredError";
  }
}

export class SportmonksRequestError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SportmonksRequestError";
  }
}

export function isLiveProviderConfigured(config: {
  provider: string;
  apiKey: string | null | undefined;
}): boolean {
  return config.provider === SPORTMONKS_PROVIDER_NAME && Boolean(config.apiKey && config.apiKey.trim());
}

export interface SportmonksClient {
  readonly name: typeof SPORTMONKS_PROVIDER_NAME;
  readonly developmentOnly: false;
  readonly configured: boolean;
  readonly apiVersion: typeof SPORTMONKS_API_VERSION;
  getInplayFixtures(include?: string): Promise<unknown>;
  getFixture(fixtureId: string | number, include?: string): Promise<unknown>;
  getFixtureEvents(fixtureId: string | number): Promise<unknown>;
}

export function createSportmonksClient(config: SportmonksProviderConfig): SportmonksClient {
  const configured = Boolean(config.apiKey && config.apiKey.trim());
  const fetchImpl = config.fetchImpl ?? fetch;
  const base = config.apiUrl.replace(/\/$/, "");

  async function request(path: string, query: Record<string, string> = {}): Promise<unknown> {
    if (!configured || !config.apiKey) {
      throw new SportmonksNotConfiguredError();
    }
    const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
    url.searchParams.set("api_token", config.apiKey);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
    const started = Date.now();
    try {
      const response = await fetchImpl(url.toString(), {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      const latencyMs = Date.now() - started;
      config.logger?.info(
        { provider: SPORTMONKS_PROVIDER_NAME, path, status: response.status, latencyMs },
        "sportmonks request",
      );
      if (!response.ok) {
        throw new SportmonksRequestError(`Sportmonks HTTP ${response.status}`, response.status);
      }
      return (await response.json()) as unknown;
    } catch (error) {
      if (error instanceof SportmonksNotConfiguredError || error instanceof SportmonksRequestError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : "Sportmonks request failed";
      throw new SportmonksRequestError(message);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    name: SPORTMONKS_PROVIDER_NAME,
    developmentOnly: false,
    configured,
    apiVersion: SPORTMONKS_API_VERSION,
    async getInplayFixtures(include = "participants;scores;events;timeline;lineups;state") {
      return request("/football/livescores/inplay", { include });
    },
    async getFixture(fixtureId, include = "participants;scores;events;timeline;lineups;state") {
      return request(`/football/fixtures/${fixtureId}`, { include });
    },
    async getFixtureEvents(fixtureId) {
      return request(`/football/fixtures/${fixtureId}`, {
        include: "events;timeline;participants;lineups;state;scores",
      });
    },
  };
}

/**
 * SportsDataProvider wrapper. Catalog methods fail closed when unconfigured
 * so callers cannot silently treat Sportmonks as a fake local catalog.
 */
export function createSportmonksSportsProvider(config: SportmonksProviderConfig): SportsDataProvider & {
  client: SportmonksClient;
  configured: boolean;
} {
  const client = createSportmonksClient(config);
  const empty: SportsCatalog = { clubs: [], players: [], matches: [], squad: [], events: [] };

  async function refuse<T>(): Promise<T> {
    if (!client.configured) {
      throw new SportmonksNotConfiguredError();
    }
    throw new SportmonksRequestError(
      "Sportmonks SportsDataProvider catalog methods require an ingestion mapping layer; use the live ingest worker",
    );
  }

  return {
    name: SPORTMONKS_PROVIDER_NAME,
    developmentOnly: false,
    configured: client.configured,
    client,
    catalog: () => empty,
    listMatches: () => refuse<ProviderMatch[]>(),
    getMatch: () => refuse<ProviderMatch | null>(),
    getSquad: () => refuse<ProviderSquadRow[]>(),
    getEvents: () => refuse<ProviderEvent[]>(),
  };
}
