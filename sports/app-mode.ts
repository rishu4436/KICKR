/**
 * APP_MODE=LIVE | DEMO | DUAL
 * LIVE / DEMO are strict single-dataset modes (Phase 18C).
 * DUAL serves both in one process; client selects via ?mode= / X-KICKR-Mode (Phase 18D).
 * Never silently fall back between modes — fail visibly if misconfigured.
 */

export const APP_MODES = ["LIVE", "DEMO", "DUAL"] as const;
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
  /** True when APP_MODE is set (strict or dual). */
  strict: boolean;
  liveFixtureId: string | null;
  /** Public UI label when process is single-mode. Null for DUAL (client selects). */
  dataLabel: "LIVE DATA" | "DEMO DATA" | null;
  /** Effective sports provider forced by APP_MODE when set. */
  effectiveSportsProvider: "sportmonks" | "demo" | null;
  /** Modes this process can serve. */
  modesAvailable: Array<"LIVE" | "DEMO">;
  dualMode: boolean;
}

export function normalizeAppMode(raw: string | null | undefined): AppMode | null {
  const n = (raw ?? "").trim().toUpperCase();
  if (n === "") return null;
  if (n === "LIVE") return "LIVE";
  if (n === "DEMO") return "DEMO";
  if (n === "DUAL") return "DUAL";
  throw new AppModeError(`Unknown APP_MODE "${raw}". Allowed: LIVE, DEMO, DUAL.`);
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
      modesAvailable: [],
      dualMode: false,
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
      modesAvailable: ["LIVE"],
      dualMode: false,
    };
  }

  if (appMode === "DUAL") {
    if (!config.liveFixtureId || !config.liveFixtureId.trim()) {
      throw new AppModeError("APP_MODE=DUAL requires LIVE_FIXTURE_ID (exactly one Sportmonks fixture for LIVE)");
    }
    if (!config.sportsApiKey || !config.sportsApiKey.trim()) {
      throw new AppModeError("APP_MODE=DUAL requires SPORTS_API_KEY");
    }
    const provider = config.sportsProvider.trim().toLowerCase().replace(/_/g, "-");
    if (provider === "local-dev") {
      throw new AppModeError("APP_MODE=DUAL refuses SPORTS_PROVIDER=local-dev");
    }
    // Live adapter is Sportmonks; DEMO catalog is seeded alongside (never mixed in responses).
    return {
      appMode: "DUAL",
      strict: true,
      liveFixtureId: config.liveFixtureId.trim(),
      dataLabel: null,
      effectiveSportsProvider: "sportmonks",
      modesAvailable: ["LIVE", "DEMO"],
      dualMode: true,
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
    modesAvailable: ["DEMO"],
    dualMode: false,
  };
}
