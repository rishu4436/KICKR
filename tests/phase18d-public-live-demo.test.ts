import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { PUBLIC_CONFIG_KEYS } from "../config/types.js";
import { normalizeAppMode, resolveAppMode, AppModeError } from "../sports/app-mode.js";
import {
  matchBelongsToMode,
  modeFromDataSource,
  parseModeQuery,
  resolveRequestMode,
} from "../sports/mode-filter.js";
import { buildDemoSingleMatchCatalog } from "../sports/demo-provider.js";
import { isDemoControlConfigured, assertDemoControlToken } from "../sports/demo-control.js";
import { ConfigError } from "../shared/errors.js";
import { AppError } from "../shared/errors.js";

const baseEnv = {
  DATABASE_URL: "postgres://kickr:supersecretpassword@localhost:5432/kickr",
  REDIS_URL: "redis://:redis-secret-password@localhost:6379/0",
  AUTH_DOMAIN: "localhost",
  SOLANA_RPC_URL: "https://api.devnet.solana.com",
};

describe("Phase 18D APP_MODE=DUAL", () => {
  it("accepts DUAL with fixture + api key and exposes both modes", () => {
    const resolved = resolveAppMode({
      appMode: "DUAL",
      liveFixtureId: "19722776",
      sportsProvider: "sportmonks",
      sportsApiKey: "k".repeat(60),
    });
    expect(resolved.dualMode).toBe(true);
    expect(resolved.modesAvailable).toEqual(["LIVE", "DEMO"]);
    expect(resolved.effectiveSportsProvider).toBe("sportmonks");
    expect(resolved.liveFixtureId).toBe("19722776");
    expect(resolved.dataLabel).toBeNull();
  });

  it("DUAL refuses missing LIVE_FIXTURE_ID or API key", () => {
    expect(() =>
      resolveAppMode({
        appMode: "DUAL",
        liveFixtureId: null,
        sportsProvider: "sportmonks",
        sportsApiKey: "k".repeat(60),
      }),
    ).toThrow(AppModeError);
    expect(() =>
      resolveAppMode({
        appMode: "DUAL",
        liveFixtureId: "19722776",
        sportsProvider: "sportmonks",
        sportsApiKey: null,
      }),
    ).toThrow(AppModeError);
  });

  it("loadConfig DUAL wires public dualMode and never leaks API key", () => {
    const key = "secret-sportmonks-key-" + "x".repeat(40);
    const config = loadConfig({
      ...baseEnv,
      APP_MODE: "DUAL",
      LIVE_FIXTURE_ID: "19722776",
      SPORTS_API_KEY: key,
      SPORTS_PROVIDER: "sportmonks",
    });
    expect(config.public.appMode).toBe("DUAL");
    expect(config.public.dualMode).toBe(true);
    expect(config.public.modesAvailable).toEqual(["LIVE", "DEMO"]);
    expect(config.public.liveFixtureId).toBe("19722776");
    expect(config.public.liveData).toBe(false);
    expect(config.public.demoData).toBe(false);
    expect(config.public.liveProviderConfigured).toBe(true);
    expect(config.server.sportsData.scoringRuleset).toBe("LIVE_V1");
    expect(Object.keys(config.public).sort()).toEqual([...PUBLIC_CONFIG_KEYS].sort());
    const serialized = JSON.stringify(config.public);
    expect(serialized).not.toContain(key);
    expect(serialized).not.toContain("SPORTS_API_KEY");
    expect(JSON.stringify(config.public)).not.toMatch(/api[_-]?key/i);
  });

  it("normalizeAppMode accepts DUAL", () => {
    expect(normalizeAppMode("dual")).toBe("DUAL");
    expect(() => normalizeAppMode("BOTH")).toThrow(AppModeError);
  });
});

describe("Phase 18D mode isolation", () => {
  it("maps providers to modes and never mixes", () => {
    expect(modeFromDataSource("sportmonks")).toBe("LIVE");
    expect(modeFromDataSource("demo")).toBe("DEMO");
    expect(modeFromDataSource("local-dev")).toBeNull();
    expect(matchBelongsToMode("sportmonks", "LIVE")).toBe(true);
    expect(matchBelongsToMode("demo", "LIVE")).toBe(false);
    expect(matchBelongsToMode("demo", "DEMO")).toBe(true);
    expect(matchBelongsToMode("sportmonks", "DEMO")).toBe(false);
  });

  it("DUAL request mode uses client selection without silent fallback", () => {
    expect(resolveRequestMode({ appMode: "DUAL", clientMode: "LIVE" })).toBe("LIVE");
    expect(resolveRequestMode({ appMode: "DUAL", clientMode: "DEMO" })).toBe("DEMO");
    expect(resolveRequestMode({ appMode: "DUAL", clientMode: null })).toBe("DEMO");
    expect(() => resolveRequestMode({ appMode: "LIVE", clientMode: "DEMO" })).toThrow(/refuses DEMO/);
    expect(() => resolveRequestMode({ appMode: "DEMO", clientMode: "LIVE" })).toThrow(/refuses LIVE/);
    expect(resolveRequestMode({ appMode: "LIVE", clientMode: null })).toBe("LIVE");
    expect(resolveRequestMode({ appMode: "DEMO", clientMode: null })).toBe("DEMO");
    expect(() => parseModeQuery("MIXED")).toThrow(/Invalid mode/);
  });

  it("DEMO catalog exposes exactly one fictional match", () => {
    const catalog = buildDemoSingleMatchCatalog();
    expect(catalog.matches).toHaveLength(1);
    expect(catalog.matches[0]!.dataSource.provider).toBe("demo");
    expect(catalog.matches[0]!.dataSource.label).toMatch(/DEMO DATA|fictional/i);
  });
});

describe("Phase 18D demo controls gated from LIVE", () => {
  const token = "demo-control-token-16";

  it("disabled in LIVE; enabled in DEMO and DUAL when token set", () => {
    expect(
      isDemoControlConfigured({ sportsProvider: "sportmonks", demoControlToken: token, appMode: "LIVE" }),
    ).toBe(false);
    expect(
      isDemoControlConfigured({ sportsProvider: "demo", demoControlToken: token, appMode: "DEMO" }),
    ).toBe(true);
    expect(
      isDemoControlConfigured({ sportsProvider: "sportmonks", demoControlToken: token, appMode: "DUAL" }),
    ).toBe(true);
    expect(
      isDemoControlConfigured({ sportsProvider: "sportmonks", demoControlToken: "", appMode: "DUAL" }),
    ).toBe(false);
  });

  it("assertDemoControlToken refuses LIVE", () => {
    expect(() =>
      assertDemoControlToken(
        { sportsProvider: "sportmonks", demoControlToken: token, appMode: "LIVE" },
        token,
      ),
    ).toThrow(AppError);
  });
});

describe("Phase 18D public money paths stay disabled", () => {
  it("production DUAL config still uses DEVNET cluster and LIVE_V1", () => {
    const mint = "So11111111111111111111111111111111111111112";
    const config = loadConfig({
      ...baseEnv,
      NODE_ENV: "production",
      APP_MODE: "DUAL",
      LIVE_FIXTURE_ID: "19722776",
      SPORTS_API_KEY: "k".repeat(60),
      SPORTS_PROVIDER: "sportmonks",
      ALLOWED_ORIGINS: "https://kickr-demo.onrender.com",
      AUTH_DOMAIN: "kickr-demo.onrender.com",
      ESCROW_PROGRAM_ID: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN",
      SOLANA_CLUSTER: "devnet",
      USDC_MINT: mint,
      SESSION_TTL_SECONDS: "86400",
      APPROVED_ATTESTORS: "ORACLE_A:1111111111111111111111111111111111111111111111111111111111111111",
    });
    expect(config.public.solanaCluster).toBe("devnet");
    expect(config.public.dualMode).toBe(true);
    expect(config.server.sportsData.scoringRuleset).toBe("LIVE_V1");
  });

  it("production refuses mainnet cluster even in DUAL", () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        NODE_ENV: "production",
        APP_MODE: "DUAL",
        LIVE_FIXTURE_ID: "19722776",
        SPORTS_API_KEY: "k".repeat(60),
        SPORTS_PROVIDER: "sportmonks",
        ALLOWED_ORIGINS: "https://kickr-demo.onrender.com",
        AUTH_DOMAIN: "kickr-demo.onrender.com",
        SOLANA_CLUSTER: "mainnet-beta",
        USDC_MINT: "So11111111111111111111111111111111111111112",
        SESSION_TTL_SECONDS: "86400",
        APPROVED_ATTESTORS: "ORACLE_A:1111111111111111111111111111111111111111111111111111111111111111",
      }),
    ).toThrow(ConfigError);
  });
});
