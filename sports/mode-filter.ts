/**
 * Client-selected LIVE/DEMO isolation (Phase 18D).
 * Never mixes datasets; never silent cross-fallback.
 */

export type DataMode = "LIVE" | "DEMO";

export function modeFromDataSource(provider: string | null | undefined): DataMode | null {
  const n = (provider ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (n === "sportmonks") return "LIVE";
  if (n === "demo") return "DEMO";
  return null;
}

export function providerForMode(mode: DataMode): "sportmonks" | "demo" {
  return mode === "LIVE" ? "sportmonks" : "demo";
}

export function parseModeQuery(raw: string | null | undefined): DataMode | null {
  const n = (raw ?? "").trim().toUpperCase();
  if (n === "LIVE" || n === "DEMO") return n;
  if (n === "") return null;
  throw new Error(`Invalid mode "${raw}". Allowed: LIVE, DEMO.`);
}

/**
 * Resolve effective data mode for a request.
 * Strict APP_MODE=LIVE|DEMO forces that mode.
 * APP_MODE=DUAL uses client mode (query/header); defaults to DEMO when omitted.
 * Unset APP_MODE: null = no mode filter (legacy).
 */
export function resolveRequestMode(input: {
  appMode: "LIVE" | "DEMO" | "DUAL" | null;
  clientMode: string | null | undefined;
}): DataMode | null {
  const client = parseModeQuery(input.clientMode);
  if (input.appMode === "LIVE") {
    if (client && client !== "LIVE") {
      throw new Error("APP_MODE=LIVE refuses DEMO mode requests (no silent cross-fallback)");
    }
    return "LIVE";
  }
  if (input.appMode === "DEMO") {
    if (client && client !== "DEMO") {
      throw new Error("APP_MODE=DEMO refuses LIVE mode requests (no silent cross-fallback)");
    }
    return "DEMO";
  }
  if (input.appMode === "DUAL") {
    return client ?? "DEMO";
  }
  return client;
}

export function matchBelongsToMode(
  dataSourceProvider: string,
  mode: DataMode | null,
): boolean {
  if (mode === null) return true;
  return modeFromDataSource(dataSourceProvider) === mode;
}
