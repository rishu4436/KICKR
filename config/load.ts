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
  const publicConfig: PublicConfig = {
    appName: "KICKR",
    environment: data.NODE_ENV,
    authDomain: data.AUTH_DOMAIN,
    solanaCluster: data.SOLANA_CLUSTER,
    escrowProgramId: data.ESCROW_PROGRAM_ID,
    usdcMint: data.USDC_MINT,
    usdcDecimals: data.USDC_DECIMALS,
    sportsDataProvider: data.SPORTS_DATA_PROVIDER,
    liveProviderConfigured:
      data.SPORTS_PROVIDER === "sportmonks" && Boolean(data.SPORTS_API_KEY && data.SPORTS_API_KEY.trim()),
  };

  assertPublicConfigShape(publicConfig);
  if (data.NODE_ENV === "production") {
    assertProductionConfig(env, data);
  }

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
        liveProvider: data.SPORTS_PROVIDER,
        pollIntervalSeconds: data.SPORTS_POLL_INTERVAL,
        requestTimeoutMs: data.SPORTS_REQUEST_TIMEOUT_MS,
        liveProviderConfigured:
          data.SPORTS_PROVIDER === "sportmonks" && Boolean(data.SPORTS_API_KEY && data.SPORTS_API_KEY.trim()),
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
    "SPORTS_DATA_PROVIDER",
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
  if (data.SPORTS_DATA_PROVIDER === "local-dev") {
    throw new ConfigError("Production refuses SPORTS_DATA_PROVIDER=local-dev fixtures");
  }
  if (data.SPORTS_PROVIDER !== "none" && data.SPORTS_PROVIDER !== "sportmonks") {
    throw new ConfigError("Production SPORTS_PROVIDER must be none or sportmonks");
  }
  if (data.SPORTS_PROVIDER === "sportmonks" && !data.SPORTS_API_KEY) {
    throw new ConfigError("Production sportmonks requires SPORTS_API_KEY");
  }
  const origins = parseOrigins(env.ALLOWED_ORIGINS ?? "");
  if (origins.length === 0 || origins.some((origin) => origin === "*" || origin.includes("*"))) {
    throw new ConfigError("Production ALLOWED_ORIGINS must be an explicit list without wildcards");
  }
}
