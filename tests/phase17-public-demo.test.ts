/**
 * Phase 17: public demo deployment readiness — demo control gating,
 * observability counters, UI labels, deploy configs, submission docs.
 */
import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config/load.js";
import {
  assertDemoControlToken,
  isDemoControlConfigured,
} from "../sports/demo-control.js";
import { RELIABILITY_COUNTERS } from "../shared/reliability.js";
import { AUDIT_EVENTS } from "../audit/events.js";
import { AppError } from "../shared/errors.js";

const PROGRAM = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "So11111111111111111111111111111111111111112";

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
  SPORTS_PROVIDER: "DEMO",
};

describe("Phase 17 demo control gating", () => {
  it("is disabled without DEMO_CONTROL_TOKEN even when SPORTS_PROVIDER=DEMO", () => {
    expect(
      isDemoControlConfigured({ sportsProvider: "demo", demoControlToken: "" }),
    ).toBe(false);
    expect(
      isDemoControlConfigured({ sportsProvider: "demo", demoControlToken: "short" }),
    ).toBe(false);
    expect(
      isDemoControlConfigured({
        sportsProvider: "demo",
        demoControlToken: "sixteen-chars!!!!",
      }),
    ).toBe(true);
  });

  it("refuses Sportmonks and LOCAL_DEV regardless of token", () => {
    expect(
      isDemoControlConfigured({
        sportsProvider: "sportmonks",
        demoControlToken: "sixteen-chars!!!!",
      }),
    ).toBe(false);
    expect(() =>
      assertDemoControlToken(
        { sportsProvider: "sportmonks", demoControlToken: "sixteen-chars!!!!" },
        "sixteen-chars!!!!",
      ),
    ).toThrow(AppError);
    expect(() =>
      assertDemoControlToken(
        { sportsProvider: "local-dev", demoControlToken: "sixteen-chars!!!!" },
        "sixteen-chars!!!!",
      ),
    ).toThrow(/DEMO/);
  });

  it("accepts matching token and rejects mismatch", () => {
    const gate = { sportsProvider: "demo", demoControlToken: "demo-control-token-xyz" };
    expect(() => assertDemoControlToken(gate, "demo-control-token-xyz")).not.toThrow();
    expect(() => assertDemoControlToken(gate, "demo-control-token-abc")).toThrow(/Invalid/);
    expect(() => assertDemoControlToken(gate, "")).toThrow();
  });

  it("loads DEMO_CONTROL_TOKEN into server config without public exposure", () => {
    const cfg = loadConfig({
      ...prodBase,
      DEMO_CONTROL_TOKEN: "demo-control-token-xyz",
    });
    expect(cfg.server.sportsData.demoControlToken).toBe("demo-control-token-xyz");
    expect(JSON.stringify(cfg.public)).not.toContain("demo-control-token");
    expect(cfg.public.demoData).toBe(true);
  });
});

describe("Phase 17 observability + audit", () => {
  it("includes demo/scoring/failed request counters", () => {
    expect(RELIABILITY_COUNTERS).toContain("demo_control_actions");
    expect(RELIABILITY_COUNTERS).toContain("scoring_rebuilds");
    expect(RELIABILITY_COUNTERS).toContain("failed_api_requests");
  });

  it("audits DEMO control actions and never implies RUN_SETTLEMENT grant", () => {
    for (const name of [
      "DEMO_MATCH_SEEDED",
      "DEMO_MATCH_ADVANCED",
      "DEMO_SCORING_WAVE",
      "DEMO_SCORE_REBUILD",
      "DEMO_FREE_FINALIZE",
    ]) {
      expect(AUDIT_EVENTS).toContain(name);
    }
  });
});

describe("Phase 17 consumer UI cleanup + DEMO indicator", () => {
  it("does not show Dev signer label; shows DEMO DATA banner copy", () => {
    const src = readFileSync(new URL("../app/src/main.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/:\s*"Dev signer"/);
    expect(src).toContain("DEMO DATA");
    expect(src).toContain("Fictional match data");
    expect(src).toContain("demoBannerHtml");
    expect(src).toContain("bottom-nav");
    expect(src).not.toContain("Try LOCAL_DEV / DEMO Cup fixtures.");
  });
});

describe("Phase 17 deploy + submission docs", () => {
  it("ships Dockerfile, compose demo, fly.toml, deploy README", () => {
    expect(existsSync(new URL("../Dockerfile", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../docker-compose.demo.yml", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../fly.toml", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../deploy/README.md", import.meta.url))).toBe(true);
  });

  it("README states FREE product, limitations, and demo instructions", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    expect(readme).toMatch(/Paid production contests are disabled/i);
    expect(readme).toMatch(/1000 bps|10%/);
    expect(readme).toMatch(/fictional/i);
    expect(readme).toMatch(/attestor not yet connected/i);
    expect(readme).toMatch(/SPORTS_PROVIDER=DEMO/);
    expect(readme).toMatch(/RUN_SETTLEMENT/);
  });

  it("DEMO.md documents match control gating", () => {
    const demo = readFileSync(new URL("../DEMO.md", import.meta.url), "utf8");
    expect(demo).toContain("DEMO_CONTROL_TOKEN");
    expect(demo).toContain("/v1/demo/control/");
    expect(demo).toContain("x-demo-control-token");
  });
});
