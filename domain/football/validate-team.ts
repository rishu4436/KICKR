import { calculateCreditsUsed, validateCreditCap } from "./credits.js";
import type { PlayerRole } from "./roles.js";

export interface TeamValidationError {
  code: string;
  message: string;
}

export interface TeamValidationResult {
  valid: boolean;
  errors: TeamValidationError[];
}

export interface FantasyRules {
  /** Integer squad-credit cap. Not USDC. TODO: production cap is unspecified; this is config. */
  creditCap: number;
  /**
   * TODO: a numeric max from one club is unspecified.
   * null means the check is not applied. Dev config leaves this null.
   * The both-clubs requirement is separate and always applied.
   */
  maxPlayersFromOneTeam: number | null;
}

export interface SquadPick {
  playerId: string;
  clubId: string;
  position: PlayerRole;
  credit: number;
}

export interface FantasySelection {
  playerIds: readonly string[];
  captainId: string;
  viceId: string;
}

export function validateFantasyTeam(
  selection: FantasySelection,
  pool: readonly SquadPick[],
  homeClubId: string,
  awayClubId: string,
  rules: FantasyRules,
): TeamValidationResult {
  const errors: TeamValidationError[] = [];
  const ids = selection.playerIds;

  if (ids.length !== 11) {
    errors.push({ code: "NOT_EXACTLY_11", message: "A fantasy team must contain exactly 11 players" });
  }

  const seen = new Set<string>();
  let duplicate = false;
  for (const id of ids) {
    if (seen.has(id)) {
      duplicate = true;
    }
    seen.add(id);
  }
  if (duplicate) {
    errors.push({ code: "DUPLICATE_PLAYER", message: "A player cannot be selected twice" });
  }

  const poolById = new Map(pool.map((player) => [player.playerId, player]));
  const resolved: SquadPick[] = [];
  let missing = false;
  for (const id of ids) {
    const player = poolById.get(id);
    if (!player) {
      missing = true;
    } else {
      resolved.push(player);
    }
  }
  if (missing) {
    errors.push({
      code: "NOT_IN_SQUAD",
      message: "Every player must be on the match official squad",
    });
  }

  if (!ids.includes(selection.captainId)) {
    errors.push({ code: "CAPTAIN_NOT_IN_XI", message: "Captain must be in the XI" });
  }
  if (!ids.includes(selection.viceId)) {
    errors.push({ code: "VICE_NOT_IN_XI", message: "Vice-captain must be in the XI" });
  }
  if (selection.captainId === selection.viceId) {
    errors.push({ code: "CAPTAIN_EQUALS_VICE", message: "Captain and vice-captain must be different players" });
  }

  const fullyResolved = !missing && !duplicate && ids.length === 11 && resolved.length === 11;
  if (fullyResolved) {
    const counts: Record<PlayerRole, number> = { GK: 0, DEF: 0, MID: 0, FWD: 0 };
    let nonIntegerCredit = false;
    for (const player of resolved) {
      if (!Number.isInteger(player.credit)) {
        nonIntegerCredit = true;
      }
      counts[player.position] += 1;
    }
    if (nonIntegerCredit) {
      errors.push({ code: "CREDIT_NOT_INTEGER", message: "Credits must be integers" });
    }
    if (counts.GK !== 1) {
      errors.push({ code: "POSITION_GK", message: "The XI must contain exactly 1 goalkeeper" });
    }
    if (counts.DEF < 3 || counts.DEF > 5) {
      errors.push({ code: "POSITION_DEF", message: "The XI must contain 3 to 5 defenders" });
    }
    if (counts.MID < 3 || counts.MID > 5) {
      errors.push({ code: "POSITION_MID", message: "The XI must contain 3 to 5 midfielders" });
    }
    if (counts.FWD < 1 || counts.FWD > 3) {
      errors.push({ code: "POSITION_FWD", message: "The XI must contain 1 to 3 forwards" });
    }

    if (!nonIntegerCredit) {
      const used = calculateCreditsUsed(resolved.map((player) => player.credit));
      if (!Number.isInteger(rules.creditCap) || !validateCreditCap(used, rules.creditCap)) {
        errors.push({
          code: "CREDIT_CAP",
          message: "Total credits must be an integer within the credit cap",
        });
      }
    }

    const clubs = new Set(resolved.map((player) => player.clubId));
    if (!clubs.has(homeClubId) || !clubs.has(awayClubId)) {
      errors.push({
        code: "MIXED_CLUBS",
        message: "The XI must use players from both clubs in the fixture",
      });
    }

    if (rules.maxPlayersFromOneTeam !== null) {
      const perClub = new Map<string, number>();
      for (const player of resolved) {
        perClub.set(player.clubId, (perClub.get(player.clubId) ?? 0) + 1);
      }
      for (const count of perClub.values()) {
        if (count > rules.maxPlayersFromOneTeam) {
          errors.push({
            code: "MAX_FROM_ONE_CLUB",
            message: "Too many players from one club",
          });
          break;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
