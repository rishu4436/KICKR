/**
 * APP_MODE=LIVE | APP_MODE=DEMO
 * Never silently fall back between modes — fail visibly if misconfigured.
 */

export const APP_MODES = ["LIVE", "DEMO"] as const;
export type AppMode = (typeof APP_MODES)[number];

export class AppModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppModeError";
  }
}

export interface AppModeConfig {
  appMode: AppMode | null;
  liveFixtureId: string | null;
  sportsProvider: string;
  sportsApiKey: string | null;
}

export interface ResolvedAppMode {
  appMode: AppMode | null;
  /** True when APP_MODE is set (strict single-match modes). */
  strict: boolean;
  liveFixtureId: string | null;
  /** Public UI label. */
  dataLabel: "LIVE DATA" | "DEMO DATA" | null;
  /** Effective sports provider forced by APP_MODE when set. */
  effectiveSportsProvider: "sportmonks" | "demo" | null;
}

export function normalizeAppMode(raw: string | null | undefined): AppMode | null {
  const n = (raw ?? "").trim().toUpperCase();
  if (n === "") return null;
  if (n === "LIVE") return "LIVE";
  if (n === "DEMO") return "DEMO";
  throw new AppModeError(`Unknown APP_MODE "${raw}". Allowed: LIVE, DEMO.`);
}

export function resolveAppMode(config: AppModeConfig): ResolvedAppMode {
  const appMode = config.appMode;
  if (appMode === null) {
    return {
      appMode: null,
      strict: false,
      liveFixtureId: null,
      dataLabel: null,
      effectiveSportsProvider: null,
    };
  }

  if (appMode === "LIVE") {
    if (!config.liveFixtureId || !config.liveFixtureId.trim()) {
      throw new AppModeError("APP_MODE=LIVE requires LIVE_FIXTURE_ID (exactly one Sportmonks fixture)");
    }
    if (!config.sportsApiKey || !config.sportsApiKey.trim()) {
      throw new AppModeError("APP_MODE=LIVE requires SPORTS_API_KEY");
    }
    const provider = config.sportsProvider.trim().toLowerCase().replace(/_/g, "-");
    if (provider && provider !== "none" && provider !== "sportmonks" && provider !== "unset") {
      if (provider === "demo" || provider === "local-dev") {
        throw new AppModeError(
          `APP_MODE=LIVE refuses SPORTS_PROVIDER=${config.sportsProvider} (no silent DEMO/local-dev fallback)`,
        );
      }
    }
    return {
      appMode: "LIVE",
      strict: true,
      liveFixtureId: config.liveFixtureId.trim(),
      dataLabel: "LIVE DATA",
      effectiveSportsProvider: "sportmonks",
    };
  }

  // DEMO
  const provider = config.sportsProvider.trim().toLowerCase().replace(/_/g, "-");
  if (provider === "sportmonks") {
    throw new AppModeError("APP_MODE=DEMO refuses SPORTS_PROVIDER=sportmonks (no silent LIVE fallback)");
  }
  if (config.liveFixtureId && config.liveFixtureId.trim()) {
    throw new AppModeError("APP_MODE=DEMO refuses LIVE_FIXTURE_ID (DEMO is fictional only)");
  }
  return {
    appMode: "DEMO",
    strict: true,
    liveFixtureId: null,
    dataLabel: "DEMO DATA",
    effectiveSportsProvider: "demo",
  };
}
