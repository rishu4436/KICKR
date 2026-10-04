import { describe, expect, it } from "vitest";
import { calculateCreditsUsed, remainingCredits, validateCreditCap } from "../domain/football/credits.js";
import { getMatchPlayerPool, getPlayersByPosition, isPlayerEligibleForMatch } from "../domain/football/eligibility.js";
import { formationLabel } from "../domain/football/presentation.js";
import { validateFantasyTeam, type FantasyRules, type SquadPick } from "../domain/football/validate-team.js";
import { buildLocalDevCatalog } from "../sports/local-dev-provider.js";
import { LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";

const rules: FantasyRules = { creditCap: 100, maxPlayersFromOneTeam: null };

function pool(): SquadPick[] {
  const catalog = buildLocalDevCatalog();
  const players = catalog.players;
  const squad = catalog.squad.filter((row) => row.matchId === LOCAL_DEV_MATCH_UPCOMING);
  return getMatchPlayerPool(
    players,
    squad.map((row) => {
      const player = players.find((item) => item.id === row.playerId);
      return {
        ...row,
        displayName: player?.displayName ?? "",
        shortName: player?.shortName ?? "",
        active: player?.active ?? false,
      };
    }),
  ).map((player) => ({
    playerId: player.playerId,
    clubId: player.clubId,
    position: player.position,
    credit: player.credit,
  }));
}

function by(role: SquadPick["position"], clubId: string, nth: number): SquadPick {
  const matches = pool().filter((player) => player.position === role && player.clubId === clubId);
  const player = matches[nth];
  if (!player) {
    throw new Error(`missing ${role} ${nth}`);
  }
  return player;
}

function validIds(): string[] {
  return [
    by("GK", LOCAL_DEV_CLUB_A, 0).playerId,
    by("DEF", LOCAL_DEV_CLUB_A, 0).playerId,
    by("DEF", LOCAL_DEV_CLUB_A, 1).playerId,
    by("DEF", LOCAL_DEV_CLUB_A, 2).playerId,
    by("DEF", LOCAL_DEV_CLUB_A, 3).playerId,
    by("MID", LOCAL_DEV_CLUB_A, 0).playerId,
    by("MID", LOCAL_DEV_CLUB_A, 1).playerId,
    by("MID", LOCAL_DEV_CLUB_B, 0).playerId,
    by("DEF", LOCAL_DEV_CLUB_B, 0).playerId,
    by("FWD", LOCAL_DEV_CLUB_B, 1).playerId,
    by("MID", LOCAL_DEV_CLUB_B, 1).playerId,
  ];
}

describe("eligibility and XI validation", () => {
  it("builds a pool only from the official included squad", () => {
    const catalog = buildLocalDevCatalog();
    const squad = catalog.squad.filter((row) => row.matchId === LOCAL_DEV_MATCH_UPCOMING);
    const excluded = squad.find((row) => row.squadStatus === "EXCLUDED");
    expect(excluded).toBeTruthy();
    const player = catalog.players.find((item) => item.id === excluded?.playerId) ?? null;
    expect(isPlayerEligibleForMatch(player, excluded ?? null)).toBe(false);
    const included = squad.find((row) => row.squadStatus === "INCLUDED");
    const includedPlayer = catalog.players.find((item) => item.id === included?.playerId) ?? null;
    expect(isPlayerEligibleForMatch(includedPlayer, included ?? null)).toBe(true);
    const picks = pool();
    expect(picks.some((item) => item.playerId === excluded?.playerId)).toBe(false);
    expect(getPlayersByPosition(picks.map((item) => ({
      ...item,
      displayName: "",
      shortName: "",
      availability: "AVAILABLE",
      startingStatus: "UNKNOWN",
      active: true,
    })), "GK").length).toBeGreaterThan(0);
  });

  it("accepts a mixed XI inside the integer credit cap", () => {
    const ids = validIds();
    const captain = ids[0] ?? "";
    const vice = ids[5] ?? "";
    const result = validateFantasyTeam(
      { playerIds: ids, captainId: captain, viceId: vice },
      pool(),
      LOCAL_DEV_CLUB_A,
      LOCAL_DEV_CLUB_B,
      rules,
    );
    expect(result.valid).toBe(true);
    const used = calculateCreditsUsed(ids.map((id) => pool().find((player) => player.playerId === id)?.credit ?? 0));
    expect(used).toBe(99);
    expect(validateCreditCap(used, 100)).toBe(true);
    expect(remainingCredits(used, 100)).toBe(1);
    expect(formationLabel(ids.map((id) => pool().find((player) => player.playerId === id)?.position ?? ""))).toBe("5-4-1");
  });

  it("rejects position limits, duplicates, squad misses, cap, captain, and single-club XIs", () => {
    const ids = validIds();
    const picks = pool();
    const captain = ids[0] ?? "";
    const vice = ids[5] ?? "";
    expect(validateFantasyTeam({ playerIds: ids.slice(0, 10), captainId: captain, viceId: vice }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("NOT_EXACTLY_11");

    const twoGk = [
      by("GK", LOCAL_DEV_CLUB_A, 0).playerId,
      by("GK", LOCAL_DEV_CLUB_A, 1).playerId,
      ...ids.slice(2),
    ];
    expect(validateFantasyTeam({ playerIds: twoGk, captainId: twoGk[0] ?? "", viceId: twoGk[5] ?? "" }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("POSITION_GK");

    const fewDef = [
      by("GK", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_B, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 1).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 2).playerId,
      by("MID", LOCAL_DEV_CLUB_B, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_B, 1).playerId,
      by("FWD", LOCAL_DEV_CLUB_A, 1).playerId,
      by("FWD", LOCAL_DEV_CLUB_B, 1).playerId,
      by("FWD", LOCAL_DEV_CLUB_B, 2).playerId,
    ];
    expect(validateFantasyTeam({ playerIds: fewDef, captainId: fewDef[0] ?? "", viceId: fewDef[3] ?? "" }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("POSITION_DEF");

    const dup = [...ids];
    dup[10] = dup[9] ?? dup[10] ?? "";
    expect(validateFantasyTeam({ playerIds: dup, captainId: captain, viceId: vice }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("DUPLICATE_PLAYER");

    const outsider = [...ids];
    outsider[10] = "30000000-0000-4000-8000-000000009999";
    expect(validateFantasyTeam({ playerIds: outsider, captainId: captain, viceId: vice }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("NOT_IN_SQUAD");

    const expensive = [
      by("GK", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 1).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 2).playerId,
      by("DEF", LOCAL_DEV_CLUB_B, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 1).playerId,
      by("MID", LOCAL_DEV_CLUB_B, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_B, 1).playerId,
      by("FWD", LOCAL_DEV_CLUB_A, 0).playerId,
      by("FWD", LOCAL_DEV_CLUB_B, 0).playerId,
    ];
    const cap = validateFantasyTeam({ playerIds: expensive, captainId: expensive[0] ?? "", viceId: expensive[5] ?? "" }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules);
    expect(cap.errors.map((e) => e.code)).toContain("CREDIT_CAP");
    expect(validateCreditCap(111, 100)).toBe(false);

    expect(validateFantasyTeam({ playerIds: ids, captainId: "30000000-0000-4000-8000-000000009999", viceId: vice }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("CAPTAIN_NOT_IN_XI");
    expect(validateFantasyTeam({ playerIds: ids, captainId: captain, viceId: "30000000-0000-4000-8000-000000009998" }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("VICE_NOT_IN_XI");
    expect(validateFantasyTeam({ playerIds: ids, captainId: captain, viceId: captain }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("CAPTAIN_EQUALS_VICE");

    const oneClub = [
      by("GK", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 1).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 2).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 3).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 4).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 1).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 2).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 3).playerId,
      by("FWD", LOCAL_DEV_CLUB_A, 1).playerId,
    ];
    expect(validateFantasyTeam({ playerIds: oneClub, captainId: oneClub[0] ?? "", viceId: oneClub[6] ?? "" }, picks, LOCAL_DEV_CLUB_A, LOCAL_DEV_CLUB_B, rules).errors.map((e) => e.code)).toContain("MIXED_CLUBS");
  });

  it("does not apply a numeric club max when the knob is null", () => {
    const skewed = [
      by("GK", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 0).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 1).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 2).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 3).playerId,
      by("DEF", LOCAL_DEV_CLUB_A, 4).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 0).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 1).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 2).playerId,
      by("MID", LOCAL_DEV_CLUB_A, 3).playerId,
      by("FWD", LOCAL_DEV_CLUB_B, 1).playerId,
    ];
    const result = validateFantasyTeam(
      { playerIds: skewed, captainId: skewed[0] ?? "", viceId: skewed[10] ?? "" },
      pool(),
      LOCAL_DEV_CLUB_A,
      LOCAL_DEV_CLUB_B,
      { creditCap: 100, maxPlayersFromOneTeam: null },
    );
    expect(result.errors.map((error) => error.code)).not.toContain("MAX_FROM_ONE_CLUB");
    expect(result.valid).toBe(true);
    const capped = validateFantasyTeam(
      { playerIds: skewed, captainId: skewed[0] ?? "", viceId: skewed[10] ?? "" },
      pool(),
      LOCAL_DEV_CLUB_A,
      LOCAL_DEV_CLUB_B,
      { creditCap: 100, maxPlayersFromOneTeam: 7 },
    );
    expect(capped.errors.map((error) => error.code)).toContain("MAX_FROM_ONE_CLUB");
  });

  it("rejects non-integer credits without float comparison", () => {
    const ids = validIds();
    const picks = pool().map((player, index) => (index === 0 ? { ...player, credit: 9.5 } : player));
    const result = validateFantasyTeam(
      { playerIds: ids, captainId: ids[0] ?? "", viceId: ids[5] ?? "" },
      picks,
      LOCAL_DEV_CLUB_A,
      LOCAL_DEV_CLUB_B,
      rules,
    );
    expect(result.errors.map((error) => error.code)).toContain("CREDIT_NOT_INTEGER");
    expect(() => calculateCreditsUsed([9.5])).toThrow(/integer/);
  });
});
