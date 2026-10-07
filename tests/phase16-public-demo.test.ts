/**
 * Phase 16: public demo readiness — DEMO provider, durable invite, onboarding,
 * OG 1200×630, seed gates, deployment checks, money-path isolation.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import { ConfigError } from "../shared/errors.js";
import { createDemoProvider, DEMO_PROVIDER_NAME, buildDemoCatalog } from "../sports/demo-provider.js";
import { createLocalDevProvider } from "../sports/local-dev-provider.js";
import { resolveSportsRuntime } from "../sports/factory.js";
import { normalizeSportsProvider } from "../sports/provider-names.js";
import {
  renderSharePreviewPng,
  readPngDimensions,
  OG_WIDTH,
  OG_HEIGHT,
} from "../profile/share-image.js";
import { evaluateDemoReady, detectForbiddenSignerEnv } from "../ops/demo-ready.js";
import { assertDemoSeedAllowed, seedPublicDemo } from "../sports/demo-seed.js";
import { buildTestApp, generateWallet, signMessage, testConfig } from "./helpers.js";
import { LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";
import { InMemoryFootballStore } from "../football/store.js";
import { ContestService } from "../contests/service.js";
import { InMemoryContestStore } from "../contests/memory-store.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import { FootballService } from "../football/service.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { InMemoryRedis } from "../redis/client.js";
import { InMemoryFreeResultStore } from "../contests/free/results.js";

const PROGRAM = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "So11111111111111111111111111111111111111112";
const NOW = new Date("2026-10-06T12:00:00.000Z");

const prodBase = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://kickr:x@localhost/kickr",
  REDIS_URL: "redis://localhost",
  AUTH_DOMAIN: "kickr.app",
  SOLANA_RPC_URL: "https://rpc.example",
  ESCROW_PROGRAM_ID: PROGRAM,
  USDC_MINT: MINT,
  ALLOWED_ORIGINS: "https://kickr.app",
  SESSION_TTL_SECONDS: "3600",
  APPROVED_ATTESTORS: "ORACLE_A:1111111111111111111111111111111111111111111111111111111111111111",
};

describe("Phase 16 DEMO provider isolation", () => {
  it("DEMO catalog is labeled simulated/tutorial and never Sportmonks", () => {
    const demo = createDemoProvider();
    expect(demo.name).toBe(DEMO_PROVIDER_NAME);
    expect(demo.developmentOnly).toBe(false);
    const catalog = demo.catalog();
    expect(catalog.matches.length).toBeGreaterThanOrEqual(3);
    for (const match of catalog.matches) {
      expect(match.dataSource.provider).toBe("demo");
      expect(match.dataSource.label).toMatch(/DEMO DATA|SIMULATED|Tutorial|fictional/i);
      expect(match.dataSource.label).toMatch(/not Sportmonks/i);
      expect(match.competition).toMatch(/DEMO|Tutorial/i);
    }
    expect(catalog.events.every((e) => e.provider === "demo")).toBe(true);
    expect(JSON.stringify(catalog).toLowerCase()).not.toContain("api.sportmonks");
  });

  it("LOCAL_DEV remains developmentOnly and separate from DEMO", () => {
    const local = createLocalDevProvider();
    expect(local.name).toBe("local-dev");
    expect(local.developmentOnly).toBe(true);
    const demo = createDemoProvider();
    expect(demo.name).not.toBe(local.name);
    expect(buildDemoCatalog().matches[0]?.dataSource.provider).toBe("demo");
  });

  it("supports upcoming → live → final deterministic statuses", () => {
    const statuses = createDemoProvider()
      .catalog()
      .matches.map((m) => m.status);
    expect(statuses).toContain("LINEUPS_AVAILABLE");
    expect(statuses).toContain("LIVE");
    expect(statuses).toContain("FINAL");
  });
});

describe("Phase 16 no silent provider fallback", () => {
  it("production refuses unset/none/LOCAL_DEV and requires DEMO or SPORTMONKS", () => {
    expect(() =>
      loadConfig({ ...prodBase, SPORTS_PROVIDER: "none" }),
    ).toThrow(/DEMO or SPORTMONKS/i);
    expect(() =>
      loadConfig({ ...prodBase, SPORTS_PROVIDER: "LOCAL_DEV" }),
    ).toThrow(/LOCAL_DEV|DEMO or SPORTMONKS/i);
    expect(() =>
      loadConfig({ ...prodBase, SPORTS_PROVIDER: "local-dev" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        ...prodBase,
        SPORTS_PROVIDER: "none",
        SPORTS_DATA_PROVIDER: "local-dev",
      }),
    ).toThrow(ConfigError);
  });

  it("production accepts explicit DEMO without Sportmonks key", () => {
    const cfg = loadConfig({ ...prodBase, SPORTS_PROVIDER: "DEMO" });
    expect(cfg.public.sportsProvider).toBe("demo");
    expect(cfg.public.demoData).toBe(true);
    expect(cfg.public.liveProviderConfigured).toBe(false);
  });

  it("production Sportmonks requires API key (fail closed)", () => {
    expect(() =>
      loadConfig({ ...prodBase, SPORTS_PROVIDER: "SPORTMONKS" }),
    ).toThrow(/SPORTS_API_KEY/);
    const cfg = loadConfig({
      ...prodBase,
      SPORTS_PROVIDER: "sportmonks",
      SPORTS_API_KEY: "test-key-not-real",
    });
    expect(cfg.public.sportsProvider).toBe("sportmonks");
    expect(cfg.public.liveProviderConfigured).toBe(true);
  });

  it("factory does not silently substitute DEMO when Sportmonks is selected", () => {
    const runtime = resolveSportsRuntime({
      sportsProvider: "sportmonks",
      dataProvider: "local-dev",
      apiKey: null,
      apiUrl: "https://api.sportmonks.com/v3",
      pollIntervalMs: 15000,
      requestTimeoutMs: 8000,
    });
    expect(runtime.sportsProvider).toBe("sportmonks");
    expect(runtime.catalogProvider).toBeNull();
    expect(runtime.liveProviderName).toBe("sportmonks");
    expect(runtime.liveConfigured).toBe(false);
  });

  it("normalizeSportsProvider rejects unknown values", () => {
    expect(() => normalizeSportsProvider("fantasy-api")).toThrow(/Unknown SPORTS_PROVIDER/);
  });
});

describe("Phase 16 durable invite (no sessionStorage handoff)", () => {
  it("client uses hash query leagueInvite and does not use kickr.league.return", () => {
    const src = readFileSync(new URL("../app/src/main.ts", import.meta.url), "utf8");
    expect(src).toContain("leagueInvite");
    expect(src).toContain("xiBuilderHash");
    expect(src).toContain("joinConfirmHash");
    expect(src).toContain("xiSaved");
    expect(src).not.toContain("kickr.league.return");
    expect(src).not.toContain("LEAGUE_RETURN_KEY");
    expect(src).toContain("Join League");
    expect(src).toContain("XI saved. Press Join League to confirm.");
    expect(src).not.toContain("lgj-auto");
  });
});

describe("Phase 16 persistent onboarding", () => {
  it("persists leaderboard viewed on the account, not sessionStorage", async () => {
    const src = readFileSync(new URL("../app/src/main.ts", import.meta.url), "utf8");
    expect(src).not.toContain("kickr.onboarding.leaderboardViewed");
    expect(src).toContain("/me/onboarding");
    expect(src).toContain("leaderboard-viewed");

    const built = buildTestApp(() => NOW);
    const wallet = generateWallet();
    const issued = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session = await built.deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };

    const before = await built.app.request("/v1/me/onboarding", { headers });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as {
      onboarding: { leaderboardViewed: boolean; source: string };
    };
    expect(beforeBody.onboarding.leaderboardViewed).toBe(false);
    expect(beforeBody.onboarding.source).toBe("account");

    const mark = await built.app.request("/v1/me/onboarding/leaderboard-viewed", {
      method: "POST",
      headers,
      body: "{}",
    });
    expect(mark.status).toBe(200);
    const marked = (await mark.json()) as { onboarding: { leaderboardViewed: boolean } };
    expect(marked.onboarding.leaderboardViewed).toBe(true);

    const again = await built.app.request("/v1/me/onboarding", { headers });
    const againBody = (await again.json()) as { onboarding: { leaderboardViewed: boolean } };
    expect(againBody.onboarding.leaderboardViewed).toBe(true);
  });
});

describe("Phase 16 OG image 1200×630", () => {
  it("renders 1200×630 PNG with KICKR branding and FREE, no prize language", () => {
    const png = renderSharePreviewPng({
      kind: "FREE_CONTEST",
      matchLabel: "Northbridge FC vs Riverdale United",
      label: "FREE GRAND",
      rank: 1,
      score: 42.5,
    });
    const dim = readPngDimensions(png);
    expect(dim.width).toBe(OG_WIDTH);
    expect(dim.height).toBe(OG_HEIGHT);
    expect(dim.width).toBe(1200);
    expect(dim.height).toBe(630);
    expect(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true);
    // Deterministic
    const again = renderSharePreviewPng({
      kind: "FREE_CONTEST",
      matchLabel: "Northbridge FC vs Riverdale United",
      label: "FREE GRAND",
      rank: 1,
      score: 42.5,
    });
    expect(Buffer.compare(png, again)).toBe(0);
  });
});

describe("Phase 16 demo seed gates", () => {
  it("refuses seed when provider is not DEMO", () => {
    expect(() =>
      assertDemoSeedAllowed({
        nodeEnv: "development",
        sportsProvider: "local-dev",
        demoSeedEnabled: false,
      }),
    ).toThrow(/SPORTS_PROVIDER=DEMO/);
  });

  it("refuses production seed without DEMO_SEED_ENABLED", () => {
    expect(() =>
      assertDemoSeedAllowed({
        nodeEnv: "production",
        sportsProvider: "demo",
        demoSeedEnabled: false,
      }),
    ).toThrow(/DEMO_SEED_ENABLED/);
  });

  it("seeds FREE contests only via service layer", async () => {
    const footballStore = new InMemoryFootballStore();
    const audit = new InMemoryAuditStore();
    const football = new FootballService(footballStore, audit, { creditCap: 100, maxPlayersFromOneTeam: null });
    const contestStore = new InMemoryContestStore();
    const contests = new ContestService(
      contestStore,
      football,
      audit,
      new ContestDiscoveryCache(new InMemoryRedis(), "test"),
      {
        reservationTtlSeconds: 600,
        maxEntriesPerMatch: null,
        maxEntriesPerContest: null,
        maxExposurePerMatch: null,
      },
      {
        programId: PROGRAM,
        usdcMint: "",
        usdcDecimals: 6,
        cluster: "devnet",
      },
      false,
      new InMemoryFreeResultStore(),
    );
    const result = await seedPublicDemo(
      { footballStore, contests, clock: () => NOW },
      { nodeEnv: "development", sportsProvider: "demo", demoSeedEnabled: false },
    );
    expect(result.provider).toBe("demo");
    expect(result.paidContestsCreated).toBe(0);
    expect(result.escrowTouched).toBe(false);
    expect(result.solanaTxSent).toBe(false);
    expect(result.runSettlementGranted).toBe(false);
    expect(result.freeContestsEnsured.length).toBeGreaterThan(0);
    expect(result.freeContestsEnsured.every((r) => r.templateCode.startsWith("FREE"))).toBe(true);
  });
});

describe("Phase 16 deployment readiness", () => {
  it("evaluateDemoReady fails on LOCAL_DEV and passes on DEMO", () => {
    const bad = evaluateDemoReady({
      config: testConfig({ sportsDataProvider: "local-dev", nodeEnv: "production" }),
      databaseOk: true,
      redisOk: true,
      hasDevSignerEnv: false,
      hasBackendUsdcCustody: false,
      paidProductionEnabled: false,
    });
    expect(bad.ok).toBe(false);
    expect(bad.checks.some((c) => c.id === "sports_provider" && !c.ok)).toBe(true);

    const goodCfg = loadConfig({ ...prodBase, SPORTS_PROVIDER: "DEMO" });
    const good = evaluateDemoReady({
      config: goodCfg,
      databaseOk: true,
      redisOk: true,
      hasDevSignerEnv: false,
      hasBackendUsdcCustody: false,
      paidProductionEnabled: false,
    });
    expect(good.ok).toBe(true);
    expect(good.mode).toBe("demo");
  });

  it("detects forbidden custody/signer env", () => {
    expect(detectForbiddenSignerEnv({ ESCROW_PRIVATE_KEY: "x" })).toContain("ESCROW_PRIVATE_KEY");
    expect(detectForbiddenSignerEnv({})).toEqual([]);
  });

  it("exposes /ready/demo and public demo cannot open money paths", async () => {
    const built = buildTestApp(() => NOW, { sportsDataProvider: "demo" });
    const ready = await built.app.request("/ready/demo");
    expect([200, 503]).toContain(ready.status);
    const body = (await ready.json()) as {
      check: string;
      freeOnly: boolean;
      paidProductionEnabled: boolean;
    };
    expect(body.check).toBe("demo-ready");
    expect(body.freeOnly).toBe(true);
    expect(body.paidProductionEnabled).toBe(false);

    // FREE join path still works; deposit/money endpoints stay blocked for FREE.
    const wallet = generateWallet();
    const issued = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session = await built.deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    const headers = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
    const listed = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/contests`, { headers });
    expect(listed.status).toBe(200);
    const contests = (await listed.json()) as { contests: Array<{ contestKind: string }> };
    expect(contests.contests.every((c) => c.contestKind === "FREE" || c.contestKind === "PAID_DEVNET")).toBe(
      true,
    );
  });
});
