import { describe, expect, it } from "vitest";
import {
  creditsPanelHtml,
  escapeText,
  initials,
  lbRowHtml,
  lockedXiBannerHtml,
  matchTitle,
  playerChip,
  resultHeroHtml,
  xiPitchHtml,
} from "../app/src/format.js";
import {
  classifyContestLifecycle,
  contestPrimaryCta,
} from "../domain/football/presentation.js";

describe("UI product polish helpers", () => {
  it("renders readable player names with initials avatar fallback (never raw codes alone)", () => {
    const html = playerChip({
      displayName: "A FWD 1",
      shortName: "AF1",
      role: "C",
      selected: true,
    });
    expect(html).toContain("A FWD 1");
    expect(html).toContain("AF"); // initials from display name
    expect(html).toContain("badge-c");
    expect(html).toContain("selected-slot");
    expect(html).not.toMatch(/>AF1</);
  });

  it("builds a saved XI pitch with C/VC and full names", () => {
    const html = xiPitchHtml([
      { displayName: "A GK 1", position: "GK", isCaptain: false, isVice: false },
      { displayName: "A DEF 1", position: "DEF", isCaptain: false, isVice: true },
      { displayName: "A MID 1", position: "MID", isCaptain: true, isVice: false },
      { displayName: "A FWD 1", position: "FWD" },
    ]);
    expect(html).toContain("pitch");
    expect(html).toContain("A MID 1");
    expect(html).toContain("badge-c");
    expect(html).toContain("badge-vc");
    expect(html).toContain("A FWD 1");
  });

  it("renders locked XI banner as read-only", () => {
    const html = lockedXiBannerHtml();
    expect(html).toContain("Read-only");
    expect(html).toContain("locked");
  });

  it("emphasizes credits remaining", () => {
    const html = creditsPanelHtml(88, 100, 12);
    expect(html).toContain("Credits remaining");
    expect(html).toContain(">12<");
    expect(html).toContain("88 / 100 used");
  });

  it("highlights user row, top-3, rank movement, and score delta", () => {
    const html = lbRowHtml({
      rank: 1,
      label: "abcd…wxyz",
      milliPoints: 12500,
      you: true,
      priorRank: 3,
      scoreDelta: 2500,
    });
    expect(html).toContain("lb-row you top-1");
    expect(html).toContain("<strong>You</strong>");
    expect(html).toContain("rank-move up");
    expect(html).toContain("+2.5");
    expect(html).toContain("12.5");
  });

  it("renders final result hero with FREE banner and no claim CTA", () => {
    const html = resultHeroHtml({
      matchLabel: "Team A vs Team B",
      contestLabel: "FREE Grand League",
      rank: 2,
      totalEntries: 10,
      scoreLabel: "18.5",
      free: true,
    });
    expect(html).toContain("Final rank");
    expect(html).toContain("#2");
    expect(html).toContain("18.5");
    expect(html).toContain("FREE contest");
    expect(html).toContain("No monetary prize");
    expect(html).not.toContain("Claim Prize");
  });

  it("uses real match names for titles", () => {
    expect(
      matchTitle({
        home: { name: "Team A", shortName: "TMA" },
        away: { name: "Team B", shortName: "TMB" },
      }),
    ).toBe("Team A vs Team B");
    expect(initials("Team A")).toBe("TA");
    expect(escapeText("<x>")).toBe("&lt;x&gt;");
  });

  it("maps UI lifecycle states to CTAs", () => {
    expect(classifyContestLifecycle({ matchStatus: "LINEUPS_AVAILABLE", hasFinalResult: false })).toBe("upcoming");
    expect(classifyContestLifecycle({ matchStatus: "LIVE", hasFinalResult: false })).toBe("live");
    expect(classifyContestLifecycle({ matchStatus: "FINAL", hasFinalResult: true })).toBe("completed");
    expect(contestPrimaryCta("upcoming")).toBe("view_contest");
    expect(contestPrimaryCta("live")).toBe("live_leaderboard");
    expect(contestPrimaryCta("completed")).toBe("view_result");
  });

  it("keeps critical layout class hooks used by responsive CSS", () => {
    const pitch = xiPitchHtml([{ displayName: "A GK 1", position: "GK" }]);
    expect(pitch).toContain('class="pitch"');
    expect(pitch).toContain('class="line"');
    const row = lbRowHtml({ rank: 2, label: "w", milliPoints: 1000 });
    expect(row).toContain("lb-row");
    expect(row).toContain("top-2");
  });
});
