/**
 * Config is split so a public object can be returned to clients
 * without a path that copies secrets.
 *
 * PUBLIC  — safe to expose (no credentials).
 * SERVER  — process behavior that is not itself a credential.
 * SECRET  — connection strings and the Solana RPC URL (often credentialed).
 *
 * The Solana RPC URL is secret-classified even for the public devnet default
 * so a later credentialed URL cannot be copied into public config by accident.
 * Phase 1 does not call it.
 */

export const PUBLIC_CONFIG_KEYS = [
  "appName",
  "environment",
  "authDomain",
  "solanaCluster",
  "sportsDataProvider",
] as const;

export type PublicConfigKey = (typeof PUBLIC_CONFIG_KEYS)[number];

export interface PublicConfig {
  appName: "KICKR";
  environment: "development" | "test" | "production";
  authDomain: string;
  solanaCluster: string;
  sportsDataProvider: string;
}

export interface ServerConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  logLevel: "debug" | "info" | "warn" | "error";
  auth: {
    domain: string;
    nonceTtlSeconds: number;
    sessionTtlSeconds: number;
  };
  rateLimit: {
    authMax: number;
    authWindowSeconds: number;
  };
  solana: {
    cluster: string;
  };
  sportsData: {
    provider: string;
  };
  fantasy: {
    creditCap: number;
    /** null: numeric max is not configured. TODO. */
    maxPlayersFromOneTeam: number | null;
  };
}

export interface SecretConfig {
  databaseUrl: string;
  redisUrl: string;
  solanaRpcUrl: string;
}

export interface AppConfig {
  public: PublicConfig;
  server: ServerConfig;
  secrets: SecretConfig;
}
