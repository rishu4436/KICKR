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
  "escrowProgramId",
  "usdcMint",
  "usdcDecimals",
  "sportsDataProvider",
  "sportsProvider",
  "liveProviderConfigured",
  "demoData",
] as const;

export type PublicConfigKey = (typeof PUBLIC_CONFIG_KEYS)[number];

export interface PublicConfig {
  appName: "KICKR";
  environment: "development" | "test" | "production";
  authDomain: string;
  solanaCluster: string;
  escrowProgramId: string;
  /** Blank until a devnet mint is configured. Never the mainnet USDC mint. */
  usdcMint: string;
  usdcDecimals: number;
  /** Resolved catalog provider name (demo | local-dev | unset). */
  sportsDataProvider: string;
  /** Authoritative SPORTS_PROVIDER (demo | sportmonks | local-dev | none). */
  sportsProvider: string;
  /** True only when SPORTS_PROVIDER=sportmonks and SPORTS_API_KEY is set. */
  liveProviderConfigured: boolean;
  /** True when the active catalog is DEMO DATA (fictional, production-demo safe). */
  demoData: boolean;
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
  /** Browser origins allowed to call the API. Empty in development. Required in production. */
  origins: readonly string[];
  solana: {
    cluster: string;
    escrowProgramId: string;
    usdcMint: string;
    usdcDecimals: number;
  };
  sportsData: {
    /** Legacy/catalog selector (SPORTS_DATA_PROVIDER). */
    provider: string;
    /** Authoritative SPORTS_PROVIDER. */
    liveProvider: string;
    pollIntervalSeconds: number;
    requestTimeoutMs: number;
    liveProviderConfigured: boolean;
    demoSeedEnabled: boolean;
  };
  fantasy: {
    creditCap: number;
    /** null: numeric max is not configured. TODO. */
    maxPlayersFromOneTeam: number | null;
  };
  contests: {
    reservationTtlSeconds: number;
    /** null: do not impose a per-match entry cap. TODO. */
    maxEntriesPerMatch: number | null;
    /** null: do not impose an extra per-contest cap. Duplicate wallet is still forbidden. TODO. */
    maxEntriesPerContest: number | null;
    /** null: do not impose a USDC exposure cap. Integer base units when set. TODO. */
    maxExposurePerMatch: number | null;
  };
  attestation: {
    /** Raw APPROVED_ATTESTORS string (ID:pubkey,...). Parsed at load into the registry. */
    approvedAttestorsRaw: string;
  };
}

export interface SecretConfig {
  databaseUrl: string;
  redisUrl: string;
  solanaRpcUrl: string;
  /** Sportmonks (or future) API key. Null when live provider is not configured. */
  sportsApiKey: string | null;
  sportsApiUrl: string;
}

export interface AppConfig {
  public: PublicConfig;
  server: ServerConfig;
  secrets: SecretConfig;
}
