import {
  assertProductionAttestorRegistry,
  createAttestorRegistry,
  parseApprovedAttestors,
} from "../attestation/registry.js";
import {
  isProductionSportsProvider,
  normalizeSportsProvider,
  type SportsProviderName,
} from "../sports/provider-names.js";
import { normalizeAppMode, resolveAppMode, AppModeError } from "../sports/app-mode.js";
import { ConfigError } from "../shared/errors.js";
import { envSchema } from "./schema.js";
import type { AppConfig, PublicConfig } from "./types.js";
import { PUBLIC_CONFIG_KEYS } from "./types.js";

export function loadConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "env";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${details}`);
  }

  const data = parsed.data;
  let sportsProvider: SportsProviderName;
  try {
    sportsProvider = normalizeSportsProvider(data.SPORTS_PROVIDER);
  } catch (error) {
    throw new ConfigError(error instanceof Error ? error.message : "Invalid SPORTS_PROVIDER");
  }

  let appModeResolved;
  try {
    const appMode = normalizeAppMode(data.APP_MODE);
    appModeResolved = resolveAppMode({
      appMode,
      liveFixtureId: data.LIVE_FIXTURE_ID || null,
      sportsProvider,
      sportsApiKey: data.SPORTS_API_KEY,
    });
  } catch (error) {
    const message =
      error instanceof AppModeError || error instanceof Error ? error.message : "Invalid APP_MODE";
    throw new ConfigError(message);
  }

  // APP_MODE forces the effective sports provider — never silently cross LIVE/DEMO.
  if (appModeResolved.effectiveSportsProvider) {
    sportsProvider = appModeResolved.effectiveSportsProvider;
  }

  // Resolve catalog name for public/config consumers.
  const catalogName = resolveCatalogName(sportsProvider, data.SPORTS_DATA_PROVIDER);
  const liveProviderConfigured =
    sportsProvider === "sportmonks" && Boolean(data.SPORTS_API_KEY && data.SPORTS_API_KEY.trim());
  const demoData =
    appModeResolved.appMode === "DEMO" ||
    (appModeResolved.appMode === null && (sportsProvider === "demo" || catalogName === "demo"));
  const liveData = appModeResolved.appMode === "LIVE" || (appModeResolved.appMode === null && liveProviderConfigured);
  const scoringRuleset = liveData || sportsProvider === "sportmonks" ? "LIVE_V1" : "DEV_V1";

  const modesAvailable = appModeResolved.modesAvailable.length
    ? appModeResolved.modesAvailable
    : demoData
      ? (["DEMO"] as Array<"LIVE" | "DEMO">)
      : liveData
        ? (["LIVE"] as Array<"LIVE" | "DEMO">)
        : [];
  const publicConfig: PublicConfig = {
    appName: "KICKR",
    environment: data.NODE_ENV,
    authDomain: data.AUTH_DOMAIN,
    solanaCluster: data.SOLANA_CLUSTER,
    escrowProgramId: data.ESCROW_PROGRAM_ID,
    usdcMint: data.USDC_MINT,
    usdcDecimals: data.USDC_DECIMALS,
    sportsDataProvider: catalogName,
    sportsProvider,
    liveProviderConfigured,
    demoData: demoData && !appModeResolved.dualMode,
    appMode: appModeResolved.appMode,
    liveData: liveData && !demoData && !appModeResolved.dualMode,
    liveFixtureId: appModeResolved.liveFixtureId,
    modesAvailable,
    dualMode: appModeResolved.dualMode,
  };

  assertPublicConfigShape(publicConfig);
  if (data.NODE_ENV === "production") {
    assertProductionConfig(env, data, sportsProvider);
  }
  const attestors = parseApprovedAttestors(data.APPROVED_ATTESTORS, data.NODE_ENV);
  assertProductionAttestorRegistry(createAttestorRegistry(attestors), data.NODE_ENV);

  return {
    public: publicConfig,
    server: {
      nodeEnv: data.NODE_ENV,
      port: data.PORT,
      logLevel: data.LOG_LEVEL,
      auth: {
        domain: data.AUTH_DOMAIN,
        nonceTtlSeconds: data.NONCE_TTL_SECONDS,
        sessionTtlSeconds: data.SESSION_TTL_SECONDS,
      },
      rateLimit: {
        authMax: data.AUTH_RATE_LIMIT_MAX,
        authWindowSeconds: data.AUTH_RATE_LIMIT_WINDOW_SECONDS,
      },
      origins: parseOrigins(data.ALLOWED_ORIGINS),
      solana: {
        cluster: data.SOLANA_CLUSTER,
        escrowProgramId: data.ESCROW_PROGRAM_ID,
        usdcMint: data.USDC_MINT,
        usdcDecimals: data.USDC_DECIMALS,
      },
      sportsData: {
        provider: data.SPORTS_DATA_PROVIDER,
        liveProvider: sportsProvider,
        pollIntervalSeconds: data.SPORTS_POLL_INTERVAL,
        requestTimeoutMs: data.SPORTS_REQUEST_TIMEOUT_MS,
        liveProviderConfigured,
        demoSeedEnabled: data.DEMO_SEED_ENABLED,
        demoControlToken: data.DEMO_CONTROL_TOKEN,
        appMode: appModeResolved.appMode,
        liveFixtureId: appModeResolved.liveFixtureId,
        modesAvailable,
        dualMode: appModeResolved.dualMode,
        scoringRuleset,
      },
      fantasy: {
        creditCap: data.FANTASY_CREDIT_CAP,
        maxPlayersFromOneTeam: data.FANTASY_MAX_PLAYERS_FROM_ONE_TEAM,
      },
      contests: {
        reservationTtlSeconds: data.RESERVATION_TTL_SECONDS,
        maxEntriesPerMatch: data.MAX_ENTRIES_PER_MATCH,
        maxEntriesPerContest: data.MAX_ENTRIES_PER_CONTEST,
        maxExposurePerMatch: data.MAX_EXPOSURE_PER_MATCH,
      },
      attestation: {
        approvedAttestorsRaw: data.APPROVED_ATTESTORS,
      },
    },
    secrets: {
      databaseUrl: data.DATABASE_URL,
      redisUrl: data.REDIS_URL,
      solanaRpcUrl: data.SOLANA_RPC_URL,
      sportsApiKey: data.SPORTS_API_KEY,
      sportsApiUrl: data.SPORTS_API_URL,
    },
  };
}

function resolveCatalogName(sportsProvider: SportsProviderName, legacy: string): string {
  if (sportsProvider === "demo") return "demo";
  if (sportsProvider === "local-dev") return "local-dev";
  if (sportsProvider === "sportmonks") return "unset";
  const n = (legacy || "unset").trim().toLowerCase().replace(/_/g, "-");
  if (n === "demo") return "demo";
  if (n === "local-dev") return "local-dev";
  if (n === "" || n === "unset" || n === "none") return "unset";
  return n;
}

/**
 * Allowlist check. Adding a secret field to PublicConfig should fail this
 * and the unit test that locks PUBLIC_CONFIG_KEYS.
 */
export function assertPublicConfigShape(config: PublicConfig): void {
  const keys = Object.keys(config).sort();
  const allowed = [...PUBLIC_CONFIG_KEYS].sort();
  if (keys.join(",") !== allowed.join(",")) {
    throw new ConfigError("Public config keys do not match the allowlist");
  }
  const serialized = JSON.stringify(config);
  if (/postgres(?:ql)?:\/\//i.test(serialized) || /redis:\/\//i.test(serialized)) {
    throw new ConfigError("Public config must not contain connection URLs");
  }
}


function parseOrigins(value: string): string[] {
  if (!value.trim()) {
    return [];
  }
  return value.split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Production refuses blank security-critical settings and development fixtures.
 * SPORTS_PROVIDER must be DEMO or SPORTMONKS — no silent fallback to none/local-dev.
 * Development keeps defaults so local boot and unit tests still load.
 */
function assertProductionConfig(
  env: Record<string, string | undefined>,
  data: {
    USDC_MINT: string;
    SPORTS_PROVIDER: string;
    SPORTS_DATA_PROVIDER: string;
    SPORTS_API_KEY: string | null;
    SOLANA_RPC_URL: string;
    ESCROW_PROGRAM_ID: string;
    AUTH_DOMAIN: string;
    SESSION_TTL_SECONDS: number;
  },
  sportsProvider: SportsProviderName,
): void {
  const required = [
    "DATABASE_URL",
    "REDIS_URL",
    "AUTH_DOMAIN",
    "SOLANA_RPC_URL",
    "ESCROW_PROGRAM_ID",
    "USDC_MINT",
    "ALLOWED_ORIGINS",
    "SESSION_TTL_SECONDS",
    "SPORTS_PROVIDER",
  ];
  const missing = required.filter((key) => env[key] === undefined || env[key]?.trim() === "");
  if (missing.length > 0) {
    throw new ConfigError(`Production configuration missing: ${missing.join(", ")}`);
  }
  if (!data.USDC_MINT) {
    throw new ConfigError("Production configuration missing: USDC_MINT");
  }
  if (!data.SOLANA_RPC_URL || !data.ESCROW_PROGRAM_ID || !data.AUTH_DOMAIN) {
    throw new ConfigError("Production configuration missing RPC, program id, or auth domain");
  }
  if (data.SESSION_TTL_SECONDS < 60) {
    throw new ConfigError("Production SESSION_TTL_SECONDS is not a safe session lifetime");
  }

  // Fail closed: production must explicitly choose DEMO or SPORTMONKS.
  if (!isProductionSportsProvider(sportsProvider)) {
    throw new ConfigError(
      "Production SPORTS_PROVIDER must be DEMO or SPORTMONKS (no silent fallback; LOCAL_DEV and none are refused)",
    );
  }
  const legacy = (data.SPORTS_DATA_PROVIDER || "").trim().toLowerCase().replace(/_/g, "-");
  if (legacy === "local-dev" || sportsProvider === "local-dev") {
    throw new ConfigError("Production refuses LOCAL_DEV sports provider (use SPORTS_PROVIDER=DEMO for fictional demo data)");
  }
  if (sportsProvider === "sportmonks" && !data.SPORTS_API_KEY) {
    throw new ConfigError("Production SPORTMONKS requires SPORTS_API_KEY");
  }
  const origins = parseOrigins(env.ALLOWED_ORIGINS ?? "");
  if (origins.length === 0 || origins.some((origin) => origin === "*" || origin.includes("*"))) {
    throw new ConfigError("Production ALLOWED_ORIGINS must be an explicit list without wildcards");
  }
}
