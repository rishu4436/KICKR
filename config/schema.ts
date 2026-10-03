import { z } from "zod";

/**
 * Env schema. Required keys fail validation when missing or blank.
 * Local development uses placeholder URLs from .env.example, not production secrets.
 * There is no escrow private key, seed phrase, or sports API secret in this schema.
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
  SOLANA_CLUSTER: stringOrDefault("devnet"),
  SOLANA_RPC_URL: stringOrDefault("https://api.devnet.solana.com"),
  SPORTS_DATA_PROVIDER: stringOrDefault("unset"),
});

export type ParsedEnv = z.infer<typeof envSchema>;
