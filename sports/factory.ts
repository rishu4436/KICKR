import type { Logger } from "../shared/logger.js";
import { createLocalDevProvider, createSportsProvider as createCatalogProvider } from "./local-dev-provider.js";
import {
  createSportmonksSportsProvider,
  isLiveProviderConfigured,
  SPORTMONKS_PROVIDER_NAME,
  DEFAULT_SPORTMONKS_API_URL,
} from "./sportmonks-provider.js";
import type { SportsDataProvider } from "./types.js";

export interface SportsRuntimeConfig {
  /** Phase 2 catalog provider: local-dev | unset */
  dataProvider: string;
  /** Live adapter selector: sportmonks | none/empty */
  liveProvider: string;
  apiKey: string | null;
  apiUrl: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  logger?: Logger;
}

export interface SportsRuntime {
  catalogProvider: SportsDataProvider | null;
  liveProviderName: string | null;
  liveConfigured: boolean;
  liveAdapter: ReturnType<typeof createSportmonksSportsProvider> | null;
  pollIntervalMs: number;
}

export function resolveSportsRuntime(config: SportsRuntimeConfig): SportsRuntime {
  const catalogProvider = createCatalogProvider(config.dataProvider);
  const liveName = (config.liveProvider || "none").trim().toLowerCase();
  if (liveName === "none" || liveName === "" || liveName === "unset") {
    return {
      catalogProvider,
      liveProviderName: null,
      liveConfigured: false,
      liveAdapter: null,
      pollIntervalMs: config.pollIntervalMs,
    };
  }
  if (liveName !== SPORTMONKS_PROVIDER_NAME) {
    throw new Error(
      `Unknown SPORTS_PROVIDER "${config.liveProvider}". Allowed: sportmonks, none.`,
    );
  }
  const liveConfigured = isLiveProviderConfigured({
    provider: SPORTMONKS_PROVIDER_NAME,
    apiKey: config.apiKey,
  });
  const liveAdapter = createSportmonksSportsProvider({
    apiKey: liveConfigured ? config.apiKey : null,
    apiUrl: config.apiUrl || DEFAULT_SPORTMONKS_API_URL,
    requestTimeoutMs: config.requestTimeoutMs,
    logger: config.logger,
  });
  return {
    catalogProvider,
    liveProviderName: SPORTMONKS_PROVIDER_NAME,
    liveConfigured,
    liveAdapter,
    pollIntervalMs: config.pollIntervalMs,
  };
}

export { createLocalDevProvider };
