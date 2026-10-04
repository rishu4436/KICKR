import { describe, expect, it } from "vitest";
import {
  MATCH_STATES,
  MATCH_TRANSITIONS,
  TEAM_TRANSITIONS,
  isTransitionLegal,
  transition,
} from "../domain/state-machine.js";
import { IllegalTransitionError } from "../shared/errors.js";

describe("match state machine", () => {
  it("accepts every legal edge", () => {
    expect(MATCH_TRANSITIONS).toHaveLength(12);
    for (const [from, to] of MATCH_TRANSITIONS) {
      expect(isTransitionLegal("MATCH", from, to)).toBe(true);
      expect(transition("MATCH", from, to)).toBe(to);
    }
  });

  it("walks the normal path, including the return to LIVE", () => {
    const path = [
      "SCHEDULED",
      "LINEUPS_AVAILABLE",
      "LOCKED",
      "LIVE",
      "HALFTIME",
      "LIVE",
      "FULL_TIME",
      "DATA_FINALIZING",
      "FINAL",
    ];
    let current = path[0] ?? "";
    for (const next of path.slice(1)) {
      current = transition("MATCH", current, next);
    }
    expect(current).toBe("FINAL");
  });

  it("rejects important illegal edges and arbitrary status writes", () => {
    const illegal: Array<[string, string]> = [
      ["SCHEDULED", "LIVE"],
      ["SCHEDULED", "LOCKED"],
      ["SCHEDULED", "FINAL"],
      ["LINEUPS_AVAILABLE", "LIVE"],
      ["LOCKED", "FULL_TIME"],
      ["HALFTIME", "FULL_TIME"],
      ["LIVE", "FINAL"],
      ["POSTPONED", "SCHEDULED"],
      ["CANCELLED", "SCHEDULED"],
      ["ABANDONED", "LIVE"],
      ["FINAL", "LIVE"],
      ["VOID", "FINAL"],
      ["DATA_FINALIZING", "LIVE"],
      ["FULL_TIME", "VOID"],
    ];
    for (const [from, to] of illegal) {
      expect(isTransitionLegal("MATCH", from, to)).toBe(false);
      expect(() => transition("MATCH", from, to)).toThrow(IllegalTransitionError);
    }
    expect("setStatus" in { isTransitionLegal, transition }).toBe(false);
    for (const state of MATCH_STATES) {
      expect(isTransitionLegal("MATCH", state, "NOT_A_STATE")).toBe(false);
    }
  });

  it("locks a fantasy team only from DRAFT", () => {
    expect(transition("TEAM", "DRAFT", "LOCKED")).toBe("LOCKED");
    expect(() => transition("TEAM", "LOCKED", "DRAFT")).toThrow(IllegalTransitionError);
    expect(TEAM_TRANSITIONS).toEqual([["DRAFT", "LOCKED"]]);
    expect(isTransitionLegal("CONTEST", "OPEN", "REFUNDED")).toBe(false);
  });
});
