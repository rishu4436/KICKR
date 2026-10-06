import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SCORING_EVENT_TYPES, type ScoringEventType } from "../domain/scoring/events.js";
import { DEV_V1_RULESET, DEV_V1_WEIGHTS } from "../domain/scoring/dev-v1.js";
import { applyMultiplier, calculatePlayerPoints, calculateTeamPoints, effectiveEvents, type ScoringEventInput } from "../domain/scoring/engine.js";
import { createLocalDevProvider } from "../sports/local-dev-provider.js";
import { LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, LOCAL_DEV_MATCH_FINAL } from "../sports/local-dev-provider.js";

const context = { matchId: "match-1", homeClubId: "home", awayClubId: "away" };

function event(partial: Partial<ScoringEventInput> & Pick<ScoringEventInput, "eventId" | "eventType" | "sequence">): ScoringEventInput {
  return {
    primaryPlayerId: "p1",
    secondaryPlayerId: null,
    supersedesEventId: null,
    ...partial,
  };
}

describe("DEV_V1 scoring", () => {
  it("has an integer weight for every canonical event and no production claim", () => {
    expect(DEV_V1_RULESET.status).toBe("DEVELOPMENT");
    expect(DEV_V1_RULESET.name).toBe("DEV_V1");
    expect(Object.keys(DEV_V1_WEIGHTS).sort()).toEqual([...SCORING_EVENT_TYPES].sort());
    for (const eventType of SCORING_EVENT_TYPES) {
      expect(Number.isInteger(DEV_V1_WEIGHTS[eventType])).toBe(true);
    }
    expect(DEV_V1_RULESET.captainMultiplier).toEqual({ numerator: 2, denominator: 1 });
    expect(DEV_V1_RULESET.viceMultiplier).toEqual({ numerator: 3, denominator: 2 });
    expect(applyMultiplier(3000, DEV_V1_RULESET.viceMultiplier)).toBe(4500);
    expect(applyMultiplier(5000, DEV_V1_RULESET.captainMultiplier)).toBe(10000);
    const sql = readFileSync(path.resolve("migrations/002_phase2_football_domain.sql"), "utf8");
    expect(sql).toContain("DEV_V1");
    expect(sql).toContain("DEVELOPMENT");
    expect(sql).toContain("credit_value bigint");
    expect(sql).not.toMatch(/numeric\s*\(/i);
    expect(sql.toLowerCase()).not.toContain("usdc");
    for (const eventType of SCORING_EVENT_TYPES) {
      expect(sql).toContain(`"${eventType}": ${DEV_V1_WEIGHTS[eventType]}`);
    }
  });

  it("replays the same log to the same integer score", () => {
    const provider = createLocalDevProvider();
    const catalog = provider.catalog();
    const raw = catalog.events.filter((row) => row.matchId === LOCAL_DEV_MATCH_FINAL);
    expect(raw.length).toBeGreaterThanOrEqual(8);
    expect(raw.every((row) => row.provider === "local-dev")).toBe(true);
    expect(raw.every((row) => row.metadata?.notSportmonks === true)).toBe(true);
    const events: ScoringEventInput[] = raw.map((row) => ({
      eventId: row.eventId,
      eventType: row.eventType,
      primaryPlayerId: row.primaryPlayerId,
      secondaryPlayerId: row.secondaryPlayerId,
      supersedesEventId: row.supersedesEventId,
      sequence: row.sequence,
    }));
    const scorers = [...new Set(events.map((row) => row.primaryPlayerId).filter(Boolean))] as string[];
    expect(scorers.length).toBeGreaterThanOrEqual(5);
    const matchContext = {
      matchId: LOCAL_DEV_MATCH_FINAL,
      homeClubId: LOCAL_DEV_CLUB_A,
      awayClubId: LOCAL_DEV_CLUB_B,
    };
    const playerIds = [...scorers, "bench-1", "bench-2", "bench-3", "bench-4", "bench-5"].slice(0, 11);
    // Pick two scorers with unequal base totals so captaincy changes the team score.
    const bases = scorers.map((playerId) => ({
      playerId,
      base: calculatePlayerPoints(events, playerId, DEV_V1_RULESET, matchContext, "player"),
    }));
    bases.sort((a, b) => b.base - a.base);
    const captainId = bases[0]!.playerId;
    const viceId = bases.find((row) => row.playerId !== captainId && row.base !== bases[0]!.base)?.playerId ?? bases[1]!.playerId;
    expect(bases[0]!.base).not.toBe(0);
    const version = { playerIds, captainId, viceId };
    const first = calculateTeamPoints(events, version, DEV_V1_RULESET, matchContext);
    const second = calculateTeamPoints(events, version, DEV_V1_RULESET, matchContext);
    expect(second).toEqual(first);
    expect(Number.isInteger(first.milliPoints)).toBe(true);
    expect(first.milliPoints).toBeGreaterThan(0);
    const swapped = calculateTeamPoints(
      events,
      { ...version, captainId: viceId, viceId: captainId },
      DEV_V1_RULESET,
      matchContext,
    );
    expect(swapped.milliPoints).not.toBe(first.milliPoints);
  });

  it("recomputes from a correction without editing the original event", () => {
    const original = event({ eventId: "e1", eventType: "GOAL", sequence: 1, primaryPlayerId: "p1" });
    const snapshot = structuredClone(original);
    const correction = event({
      eventId: "e2",
      eventType: "VAR_REVERSAL" as ScoringEventType,
      sequence: 2,
      primaryPlayerId: "p1",
      supersedesEventId: "e1",
    });
    const before = calculatePlayerPoints([original], "p1", DEV_V1_RULESET, context, "captain");
    expect(before).toBe(10000);
    const after = calculatePlayerPoints([original, correction], "p1", DEV_V1_RULESET, context, "captain");
    expect(after).toBe(0);
    expect(original).toEqual(snapshot);
    expect(effectiveEvents([original, correction]).map((row) => row.eventId)).toEqual(["e2"]);
    const team = calculateTeamPoints(
      [original, correction],
      { playerIds: ["p1"], captainId: "p1", viceId: "p2" },
      DEV_V1_RULESET,
      context,
    );
    expect(team.milliPoints).toBe(0);
  });
});
