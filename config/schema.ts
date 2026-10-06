import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import { assertDevCluster, DEFAULT_ESCROW_PROGRAM_ID, FORBIDDEN_MAINNET_USDC_MINT } from "../solana/ids.js";

/**
 * Env schema. Required keys fail validation when missing or blank.
 * Local development uses placeholder URLs from .env.example, not production secrets.
 * There is no escrow private key or seed phrase in this schema. SPORTS_API_KEY is secret-classified when set.
 */

const domainSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9.-]+(?::\d{1,5})?$/,
    "AUTH_DOMAIN must be a hostname, optionally with a port, not a URL",
  );

function stringOrDefault(fallback: string) {
  return z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : value),
    z.string().min(1),
  );
}

function intOrDefault(fallback: number) {
  return z.preprocess(
    (value) => (value === undefined || value === "" ? fallback : value),
    z.coerce.number().int().positive(),
  );
}

export const envSchema = z.object({
  NODE_ENV: z.preprocess(
    (value) => (value === undefined || value === "" ? "development" : value),
    z.enum(["development", "test", "production"]),
  ),
  PORT: intOrDefault(3000),
  LOG_LEVEL: z.preprocess(
    (value) => (value === undefined || value === "" ? "info" : value),
    z.enum(["debug", "info", "warn", "error"]),
  ),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  AUTH_DOMAIN: domainSchema,
  NONCE_TTL_SECONDS: intOrDefault(300),
  SESSION_TTL_SECONDS: intOrDefault(86_400),
  AUTH_RATE_LIMIT_MAX: intOrDefault(30),
  AUTH_RATE_LIMIT_WINDOW_SECONDS: intOrDefault(60),
  ALLOWED_ORIGINS: z.preprocess(
    (value) => (value === undefined || value === "" ? "" : value),
    z.string(),
  ),
  SOLANA_CLUSTER: stringOrDefault("devnet").refine((value) => {
    try {
      assertDevCluster(value);
      return true;
    } catch {
      return false;
    }
  }, "KICKR escrow refuses mainnet. Use devnet, localnet, localhost, or testnet."),
  SOLANA_RPC_URL: stringOrDefault("https://api.devnet.solana.com"),
  ESCROW_PROGRAM_ID: stringOrDefault(DEFAULT_ESCROW_PROGRAM_ID),
  USDC_MINT: z.preprocess(
    (value) => (value === undefined || value === "" ? "" : value),
    z.string().refine((value) => {
      if (value === "") {
        return true;
      }
      if (value === FORBIDDEN_MAINNET_USDC_MINT) {
        return false;
      }
      try {
        void new PublicKey(value);
        return true;
      } catch {
        return false;
      }
    }, "USDC_MINT must be blank or a configured devnet mint. The mainnet USDC mint is refused."),
  ),
  USDC_DECIMALS: z.preprocess(
    (value) => (value === undefined || value === "" ? 6 : value),
    z.coerce.number().int().min(0).max(9),
  ),
  SPORTS_DATA_PROVIDER: stringOrDefault("unset"),
  // Live adapter. "sportmonks" requires SPORTS_API_KEY. Never silently fakes live data.
  SPORTS_PROVIDER: stringOrDefault("none"),
  SPORTS_API_KEY: z.preprocess(
    (value) => (value === undefined || value === "" ? null : value),
    z.union([z.null(), z.string().min(1)]),
  ),
  SPORTS_API_URL: stringOrDefault("https://api.sportmonks.com/v3"),
  SPORTS_POLL_INTERVAL: intOrDefault(15),
  SPORTS_REQUEST_TIMEOUT_MS: intOrDefault(8000),
  // TODO: 100 is a development default, not a confirmed production credit cap.
  FANTASY_CREDIT_CAP: intOrDefault(100),
  // Blank means the numeric per-club max is unset. Do not invent one.
  FANTASY_MAX_PLAYERS_FROM_ONE_TEAM: z.preprocess(
    (value) => (value === undefined || value === "" ? null : value),
    z.union([z.null(), z.coerce.number().int().positive()]),
  ),
  RESERVATION_TTL_SECONDS: intOrDefault(600),
  // Blank means unset. TODO: do not invent entry or exposure caps.
  MAX_ENTRIES_PER_MATCH: z.preprocess(
    (value) => (value === undefined || value === "" ? null : value),
    z.union([z.null(), z.coerce.number().int().positive()]),
  ),
  MAX_ENTRIES_PER_CONTEST: z.preprocess(
    (value) => (value === undefined || value === "" ? null : value),
    z.union([z.null(), z.coerce.number().int().positive()]),
  ),
  MAX_EXPOSURE_PER_MATCH: z.preprocess(
    (value) => (value === undefined || value === "" ? null : value),
    z.union([z.null(), z.coerce.number().int().positive()]),
  ),
});

export type ParsedEnv = z.infer<typeof envSchema>;
