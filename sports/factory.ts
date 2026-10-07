import type { Logger } from "../shared/logger.js";
import { createDemoProvider, createDemoSingleMatchProvider, DEMO_PROVIDER_NAME } from "./demo-provider.js";
import { createLocalDevProvider, createSportsProvider as createCatalogProvider } from "./local-dev-provider.js";
import { normalizeSportsProvider, type SportsProviderName } from "./provider-names.js";
import {
  createSportmonksSportsProvider,
  isLiveProviderConfigured,
  SPORTMONKS_PROVIDER_NAME,
  DEFAULT_SPORTMONKS_API_URL,
} from "./sportmonks-provider.js";
import type { SportsDataProvider } from "./types.js";

export interface SportsRuntimeConfig {
  /**
   * Authoritative selector (SPORTS_PROVIDER): demo | sportmonks | local-dev | none.
   * Production must be demo or sportmonks — validated at config load.
   */
  sportsProvider: string;
  /**
   * Legacy catalog env (SPORTS_DATA_PROVIDER). Used only when sportsProvider is none
   * so local developer machines keep working with SPORTS_DATA_PROVIDER=local-dev.
   */
  dataProvider: string;
  apiKey: string | null;
  apiUrl: string;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  logger?: Logger;
  /** When APP_MODE=DEMO, catalog is exactly one fictional match. */
  appMode?: "LIVE" | "DEMO" | null;
  liveFixtureId?: string | null;
}

export interface SportsRuntime {
  catalogProvider: SportsDataProvider | null;
  /** Resolved authoritative provider name. */
  sportsProvider: SportsProviderName;
  liveProviderName: string | null;
  liveConfigured: boolean;
  liveAdapter: ReturnType<typeof createSportmonksSportsProvider> | null;
  pollIntervalMs: number;
  liveFixtureId: string | null;
  appMode: "LIVE" | "DEMO" | null;
}

function resolveCatalog(
  provider: SportsProviderName,
  legacyDataProvider: string,
  appMode: "LIVE" | "DEMO" | null | undefined,
): SportsDataProvider | null {
  if (provider === "demo") {
    return appMode === "DEMO" ? createDemoSingleMatchProvider() : createDemoProvider();
  }
  if (provider === "local-dev") {
    return createLocalDevProvider();
  }
  if (provider === "sportmonks") {
    // Live adapter owns fixtures; no fictional catalog overlay.
    return null;
  }
  // provider === "none": legacy SPORTS_DATA_PROVIDER for local/dev/test only.
  const legacy = (legacyDataProvider || "unset").trim().toLowerCase();
  if (legacy === "demo") {
    return createDemoProvider();
  }
  return createCatalogProvider(legacy === "" ? "unset" : legacy);
}

export function resolveSportsRuntime(config: SportsRuntimeConfig): SportsRuntime {
  const sportsProvider = normalizeSportsProvider(config.sportsProvider);
  const catalogProvider = resolveCatalog(sportsProvider, config.dataProvider, config.appMode);

  if (sportsProvider === "sportmonks") {
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
      sportsProvider,
      liveProviderName: SPORTMONKS_PROVIDER_NAME,
      liveConfigured,
      liveAdapter,
      pollIntervalMs: config.pollIntervalMs,
      liveFixtureId: config.liveFixtureId ?? null,
      appMode: config.appMode ?? null,
    };
  }

  return {
    catalogProvider,
    sportsProvider,
    liveProviderName: null,
    liveConfigured: false,
    liveAdapter: null,
    pollIntervalMs: config.pollIntervalMs,
    liveFixtureId: config.liveFixtureId ?? null,
    appMode: config.appMode ?? null,
  };
}

export { createLocalDevProvider, createDemoProvider, DEMO_PROVIDER_NAME };
