/**
 * Production-demo readiness checks. Fail loudly with actionable messages.
 * FREE only; no LOCAL_DEV; DEMO or Sportmonks; DB/Redis healthy; no dev signer; no backend USDC custody.
 */
import type { AppConfig } from "../config/types.js";
import { normalizeSportsProvider } from "../sports/provider-names.js";

export interface DemoReadyCheck {
  id: string;
  ok: boolean;
  message: string;
}

export interface DemoReadyReport {
  ok: boolean;
  mode: "demo" | "sportmonks" | "invalid";
  checks: DemoReadyCheck[];
}

export interface DemoReadyInput {
  config: AppConfig;
  databaseOk: boolean;
  redisOk: boolean;
  /** True if any process env looks like a custody/dev signer private key. */
  hasDevSignerEnv: boolean;
  /** True if backend holds a USDC-moving key (must always be false). */
  hasBackendUsdcCustody: boolean;
  /** When true, paid production contest paths are enabled (must be false for demo). */
  paidProductionEnabled: boolean;
}

export function evaluateDemoReady(input: DemoReadyInput): DemoReadyReport {
  const checks: DemoReadyCheck[] = [];
  const nodeEnv = input.config.server.nodeEnv;
  let sportsProvider: string;
  try {
    sportsProvider = normalizeSportsProvider(input.config.server.sportsData.liveProvider);
  } catch (error) {
    sportsProvider = "invalid";
    checks.push({
      id: "sports_provider_parse",
      ok: false,
      message: error instanceof Error ? error.message : "Invalid SPORTS_PROVIDER",
    });
  }

  const isDemo = sportsProvider === "demo";
  const isSportmonks = sportsProvider === "sportmonks";
  const mode: DemoReadyReport["mode"] = isDemo ? "demo" : isSportmonks ? "sportmonks" : "invalid";

  checks.push({
    id: "sports_provider",
    ok: isDemo || isSportmonks,
    message: isDemo || isSportmonks
      ? `SPORTS_PROVIDER=${sportsProvider}`
      : `SPORTS_PROVIDER must be DEMO or SPORTMONKS (got "${input.config.server.sportsData.liveProvider}")`,
  });

  checks.push({
    id: "no_local_dev",
    ok: sportsProvider !== "local-dev" && input.config.public.sportsDataProvider !== "local-dev",
    message:
      sportsProvider === "local-dev" || input.config.public.sportsDataProvider === "local-dev"
        ? "LOCAL_DEV is refused for production-demo (set SPORTS_PROVIDER=DEMO)"
        : "LOCAL_DEV not active",
  });

  checks.push({
    id: "free_only",
    ok: !input.paidProductionEnabled,
    message: input.paidProductionEnabled
      ? "Paid production contest paths are enabled — refuse for public demo"
      : "Paid production paths disabled (FREE only)",
  });

  if (nodeEnv === "production") {
    checks.push({
      id: "production_paid_guard",
      ok: !input.config.server.nodeEnv || input.config.server.nodeEnv === "production"
        ? !input.paidProductionEnabled
        : true,
      message: "Production must keep allowPaidDevnet=false",
    });
  }

  checks.push({
    id: "database",
    ok: input.databaseOk,
    message: input.databaseOk ? "Database healthy" : "Database unhealthy — check DATABASE_URL and migrations",
  });

  checks.push({
    id: "redis",
    ok: input.redisOk,
    message: input.redisOk ? "Redis healthy" : "Redis unhealthy — check REDIS_URL",
  });

  checks.push({
    id: "no_dev_signer",
    ok: !input.hasDevSignerEnv,
    message: input.hasDevSignerEnv
      ? "Dev signer / private key env detected — remove before public demo"
      : "No dev signer env",
  });

  checks.push({
    id: "no_usdc_custody",
    ok: !input.hasBackendUsdcCustody,
    message: input.hasBackendUsdcCustody
      ? "Backend USDC custody key present — KICKR must not custody user funds"
      : "No backend USDC custody",
  });

  if (isDemo) {
    checks.push({
      id: "demo_label",
      ok: input.config.public.demoData === true,
      message: input.config.public.demoData
        ? "Public config labels DEMO DATA"
        : "Public config missing demoData=true for DEMO provider",
    });
  }

  if (isSportmonks) {
    checks.push({
      id: "sportmonks_key",
      ok: input.config.public.liveProviderConfigured,
      message: input.config.public.liveProviderConfigured
        ? "Sportmonks configured with API key"
        : "SPORTMONKS selected but SPORTS_API_KEY missing",
    });
  }

  return {
    ok: checks.every((c) => c.ok),
    mode,
    checks,
  };
}

/** Env keys that must never be set for a public demo (custody / signing). */
export const FORBIDDEN_DEMO_SIGNER_ENV = [
  "ESCROW_AUTHORITY_SECRET",
  "ESCROW_PRIVATE_KEY",
  "SOLANA_PRIVATE_KEY",
  "BACKEND_USDC_KEY",
  "DEV_SIGNER_SECRET",
  "WALLET_PRIVATE_KEY",
] as const;

export function detectForbiddenSignerEnv(env: Record<string, string | undefined>): string[] {
  return FORBIDDEN_DEMO_SIGNER_ENV.filter((key) => {
    const v = env[key];
    return typeof v === "string" && v.trim().length > 0;
  });
}
