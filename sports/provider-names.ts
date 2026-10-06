/**
 * Canonical sports provider names. Production must set SPORTS_PROVIDER explicitly
 * to DEMO or SPORTMONKS — no silent fallback. LOCAL_DEV is developer-only.
 */

export const SPORTS_PROVIDERS = ["demo", "sportmonks", "local-dev", "none"] as const;
export type SportsProviderName = (typeof SPORTS_PROVIDERS)[number];

/** Normalize env values (DEMO, LOCAL_DEV, Sportmonks, etc.) to canonical lowercase. */
export function normalizeSportsProvider(raw: string | null | undefined): SportsProviderName {
  const n = (raw ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (n === "" || n === "unset") return "none";
  if (n === "demo") return "demo";
  if (n === "sportmonks" || n === "sportmonk") return "sportmonks";
  if (n === "local-dev" || n === "localdev") return "local-dev";
  if (n === "none") return "none";
  throw new Error(
    `Unknown SPORTS_PROVIDER "${raw}". Allowed: DEMO, SPORTMONKS, LOCAL_DEV (dev only), none.`,
  );
}

export function isProductionSportsProvider(name: SportsProviderName): boolean {
  return name === "demo" || name === "sportmonks";
}
