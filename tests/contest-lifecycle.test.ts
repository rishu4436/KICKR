import { describe, expect, it } from "vitest";
import {
  classifyContestLifecycle,
  contestPrimaryCta,
} from "../domain/football/presentation.js";
import { nextContestFillStatus } from "../domain/state-machine.js";
import { IllegalTransitionError } from "../shared/errors.js";

describe("contest lifecycle classifier", () => {
  it("keeps FULL and LOCKED contests out of completed when match is pre-kickoff", () => {
    expect(classifyContestLifecycle({ matchStatus: "LINEUPS_AVAILABLE" })).toBe("upcoming");
    expect(classifyContestLifecycle({ matchStatus: "LOCKED" })).toBe("upcoming");
    expect(classifyContestLifecycle({ matchStatus: "SCHEDULED" })).toBe("upcoming");
  });

  it("marks in-progress matches as live and finalized as completed", () => {
    expect(classifyContestLifecycle({ matchStatus: "LIVE" })).toBe("live");
    expect(classifyContestLifecycle({ matchStatus: "HALFTIME" })).toBe("live");
    expect(classifyContestLifecycle({ matchStatus: "FINAL" })).toBe("completed");
    expect(classifyContestLifecycle({ matchStatus: "FULL_TIME" })).toBe("completed");
  });

  it("prefers free final result over live match status for completed", () => {
    expect(classifyContestLifecycle({ matchStatus: "LIVE", hasFinalResult: true })).toBe("completed");
  });

  it("maps primary CTAs correctly (upcoming never view_result)", () => {
    expect(contestPrimaryCta("upcoming")).toBe("view_contest");
    expect(contestPrimaryCta("live")).toBe("live_leaderboard");
    expect(contestPrimaryCta("completed")).toBe("view_result");
  });
});

describe("nextContestFillStatus", () => {
  it("skips illegal PARTIALLY_FILLED self-transition", () => {
    expect(nextContestFillStatus("OPEN", 1, 1000)).toBe("PARTIALLY_FILLED");
    expect(nextContestFillStatus("PARTIALLY_FILLED", 2, 1000)).toBe("PARTIALLY_FILLED");
    expect(nextContestFillStatus("PARTIALLY_FILLED", 3, 1000)).toBe("PARTIALLY_FILLED");
    expect(nextContestFillStatus("PARTIALLY_FILLED", 1000, 1000)).toBe("FULL");
    expect(nextContestFillStatus("PARTIALLY_FILLED", 2, 2)).toBe("FULL");
  });

  it("rejects fill from a locked contest", () => {
    expect(() => nextContestFillStatus("LOCKED", 1, 1000)).toThrow(IllegalTransitionError);
  });
});
