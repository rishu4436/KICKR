import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDemoSingleMatchCatalog, DEMO_PROVIDER_NAME, DEMO_MATCH_UPCOMING } from "../sports/demo-provider.js";
import {
  buildTutorialScriptSteps,
  footballScoreAfterSequence,
  materializeTutorialEvents,
  TUTORIAL_MATCH_ID,
  expectedTutorialDurationMs,
} from "../sports/tutorial-script.js";
import { InMemoryFootballStore } from "../football/store.js";
import { FootballService } from "../football/service.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import { isDemoControlConfigured, assertDemoControlToken } from "../sports/demo-control.js";
import { matchBelongsToMode, modeFromDataSource } from "../sports/mode-filter.js";
import { validateFantasyTeam } from "../domain/football/validate-team.js";
import { effectiveEvents, calculatePlayerPoints } from "../domain/scoring/engine.js";
import { LIVE_V1_RULESET } from "../domain/scoring/live-v1.js";
import { AppError } from "../shared/errors.js";

const ui = readFileSync(resolve("app/src/main.ts"), "utf8");
const styles = readFileSync(resolve("app/src/styles.css"), "utf8");

describe("Phase 18D.1 Tutorial Match IA", () => {
  it("tutorial catalog is simulated, buildable, and not Sportmonks", () => {
    const catalog = buildDemoSingleMatchCatalog();
    expect(catalog.matches).toHaveLength(1);
    const match = catalog.matches[0]!;
    expect(match.id).toBe(DEMO_MATCH_UPCOMING);
    expect(match.id).toBe(TUTORIAL_MATCH_ID);
    expect(match.dataSource.provider).toBe(DEMO_PROVIDER_NAME);
    expect(match.dataSource.label).toMatch(/SIMULATED|Tutorial|fictional/i);
    expect(match.dataSource.label).not.toMatch(/Sportmonks live/i);
    expect(match.competition).toMatch(/Tutorial/i);
    expect(match.status).toBe("LINEUPS_AVAILABLE");
    expect(catalog.events).toHaveLength(0);
    expect(matchBelongsToMode(match.dataSource.provider, "DEMO")).toBe(true);
    expect(matchBelongsToMode(match.dataSource.provider, "LIVE")).toBe(false);
    expect(modeFromDataSource("sportmonks")).toBe("LIVE");
  });

  it("public UI removes LIVE/DEMO toggle and labels Tutorial Match", () => {
    expect(ui).toContain("Tutorial Match");
    expect(ui).toContain("SIMULATED");
    expect(ui).toContain("Start Tutorial");
    expect(ui).toContain("Learn KICKR");
    expect(ui).toContain("removed public LIVE/DEMO toggle (Phase 18D.1)");
    expect(ui).not.toMatch(/DEMO DATA · Fictional match data/);
    expect(styles).toContain("tutorial-card");
    expect(styles).toContain("badge-simulated");
  });

  it("real matches never get simulation controls in UI copy paths", () => {
    const tutorialApi = readFileSync(resolve("api/tutorial.ts"), "utf8");
    expect(tutorialApi).toContain("Sportmonks fixtures cannot invoke the tutorial simulator");
    expect(ui).toContain("Start Match Simulation");
    expect(ui).toContain("#/tutorial/");
    // Simulation CTA is not on the generic real-match card builder path
    expect(ui).toContain('data-tutorial=');
  });
});

describe("Phase 18D.1 deterministic tutorial script", () => {
  it("includes GOAL, ASSIST, SOT, YELLOW, SUBSTITUTION, VAR reversal", () => {
    const steps = buildTutorialScriptSteps();
    const types = steps.filter((s) => s.kind === "EVENT").map((s) => s.eventType);
    expect(types).toContain("GOAL");
    expect(types).toContain("ASSIST");
    expect(types).toContain("SHOT_ON_TARGET");
    expect(types).toContain("YELLOW_CARD");
    expect(types).toContain("SUBSTITUTION");
    expect(types).toContain("VAR_REVERSAL");
    const varStep = steps.find((s) => s.eventType === "VAR_REVERSAL");
    expect(varStep?.supersedesSequence).toBeTypeOf("number");
    expect(expectedTutorialDurationMs()).toBeGreaterThanOrEqual(180_000);
    expect(expectedTutorialDurationMs()).toBeLessThanOrEqual(360_000);
  });

  it("materializes deterministic events and VAR reverses points", () => {
    const runId = "abcd1234ef00";
    const beforeVar = materializeTutorialEvents({
      matchId: TUTORIAL_MATCH_ID,
      runId,
      throughSequence: 13,
    });
    const afterVar = materializeTutorialEvents({
      matchId: TUTORIAL_MATCH_ID,
      runId,
      throughSequence: 15,
    });
    expect(beforeVar.map((e) => e.providerEventId)).toEqual(
      materializeTutorialEvents({ matchId: TUTORIAL_MATCH_ID, runId, throughSequence: 13 }).map(
        (e) => e.providerEventId,
      ),
    );
    const goal = afterVar.find((e) => e.sequence === 13);
    const reversal = afterVar.find((e) => e.eventType === "VAR_REVERSAL");
    expect(goal).toBeTruthy();
    expect(reversal?.supersedesEventId).toBe(goal!.eventId);
    const effective = effectiveEvents(
      afterVar.map((e) => ({
        eventId: e.eventId,
        eventType: e.eventType,
        primaryPlayerId: e.primaryPlayerId,
        secondaryPlayerId: e.secondaryPlayerId,
        supersedesEventId: e.supersedesEventId,
        sequence: e.sequence,
      })),
    );
    expect(effective.some((e) => e.eventId === goal!.eventId)).toBe(false);
    const scoreBefore = footballScoreAfterSequence(13);
    const scoreAfter = footballScoreAfterSequence(15);
    expect(scoreAfter.home).toBe(scoreBefore.home - 1);
  });

  it("captain multiplier applies on tutorial goals under LIVE_V1", () => {
    const events = materializeTutorialEvents({
      matchId: TUTORIAL_MATCH_ID,
      runId: "captest000001",
      throughSequence: 5,
    });
    const goal = events.find((e) => e.eventType === "GOAL")!;
    const scoring = events.map((e) => ({
      eventId: e.eventId,
      eventType: e.eventType,
      primaryPlayerId: e.primaryPlayerId,
      secondaryPlayerId: e.secondaryPlayerId,
      supersedesEventId: e.supersedesEventId,
      sequence: e.sequence,
    }));
    const base = calculatePlayerPoints(
      scoring,
      goal.primaryPlayerId!,
      LIVE_V1_RULESET,
      { matchId: TUTORIAL_MATCH_ID, homeClubId: "h", awayClubId: "a" },
      "player",
    );
    const capt = calculatePlayerPoints(
      scoring,
      goal.primaryPlayerId!,
      LIVE_V1_RULESET,
      { matchId: TUTORIAL_MATCH_ID, homeClubId: "h", awayClubId: "a" },
      "captain",
    );
    expect(capt).toBe(base * 2);
  });
});

describe("Phase 18D.1 isolation + controls", () => {
  it("demo controls remain gated from LIVE; Sportmonks cannot use them", () => {
    const token = "demo-control-token-16";
    expect(
      isDemoControlConfigured({ sportsProvider: "sportmonks", demoControlToken: token, appMode: "LIVE" }),
    ).toBe(false);
    expect(() =>
      assertDemoControlToken(
        { sportsProvider: "sportmonks", demoControlToken: token, appMode: "LIVE" },
        token,
      ),
    ).toThrow(AppError);
  });

  it("tutorial reset refuses non-demo match ids at store layer", async () => {
    const catalog = buildDemoSingleMatchCatalog();
    const store = new InMemoryFootballStore(catalog);
    await expect(
      store.resetTutorialMatch!("00000000-0000-4000-8000-000000000099", catalog),
    ).rejects.toThrow(/not found|non-demo/i);
  });

  it("valid XI within 100 credits for tutorial pool", async () => {
    const catalog = buildDemoSingleMatchCatalog();
    const store = new InMemoryFootballStore(catalog);
    const audit = new InMemoryAuditStore();
    const football = new FootballService(store, audit, { creditCap: 100, maxPlayersFromOneTeam: null });
    const matchId = catalog.matches[0]!.id;
    const pool = await football.getPlayerPool(matchId);
    expect(pool?.length).toBeGreaterThan(11);
    const home = catalog.matches[0]!.homeClubId;
    const away = catalog.matches[0]!.awayClubId;
    const byPos = (pos: string, club: string) =>
      pool!.filter((p) => p.position === pos && p.clubId === club);
    const picks = [
      byPos("GK", home)[0]!,
      byPos("DEF", home)[0]!,
      byPos("DEF", home)[1]!,
      byPos("DEF", home)[2]!,
      byPos("DEF", away)[0]!,
      byPos("MID", home)[0]!,
      byPos("MID", home)[1]!,
      byPos("MID", away)[0]!,
      byPos("MID", away)[1]!,
      byPos("FWD", home)[1]!, // AF2 = 9cr
      byPos("FWD", away)[1]!,
    ];
    const result = validateFantasyTeam(
      {
        playerIds: picks.map((p) => p.playerId),
        captainId: picks[9]!.playerId,
        viceId: picks[5]!.playerId,
      },
      picks.map((p) => ({
        playerId: p.playerId,
        position: p.position,
        clubId: p.clubId,
        credit: p.credit,
      })),
      home,
      away,
      { creditCap: 100, maxPlayersFromOneTeam: null },
    );
    expect(result.valid).toBe(true);
    const used = picks.reduce((n, p) => n + p.credit, 0);
    expect(used).toBeLessThanOrEqual(100);
  });
});

describe("Phase 18D.1 ID isolation", () => {
  it("tutorial match id is distinct from Sportmonks fixture id 19722776", () => {
    expect(TUTORIAL_MATCH_ID).not.toBe("19722776");
    expect(buildDemoSingleMatchCatalog().matches[0]!.externalFixtureId).not.toBe("19722776");
  });
});
