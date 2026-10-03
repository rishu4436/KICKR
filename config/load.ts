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
    sportsDataProvider: data.SPORTS_DATA_PROVIDER,
  };

  assertPublicConfigShape(publicConfig);

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
      solana: {
        cluster: data.SOLANA_CLUSTER,
      },
      sportsData: {
        provider: data.SPORTS_DATA_PROVIDER,
      },
    },
    secrets: {
      databaseUrl: data.DATABASE_URL,
      redisUrl: data.REDIS_URL,
      solanaRpcUrl: data.SOLANA_RPC_URL,
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
