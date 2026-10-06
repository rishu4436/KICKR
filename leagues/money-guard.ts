import { AppError } from "../shared/errors.js";

/**
 * Fail-closed: private leagues never enter monetary / escrow / settlement / claim paths.
 * Same isolation posture as FREE contests.
 */
export function rejectLeagueMoneyPath(path: string, leagueId?: string | null): never {
  throw new AppError(
    "LEAGUE_MONEY_FORBIDDEN",
    409,
    `Private FREE leagues cannot use ${path}`,
    { details: { leagueId: leagueId ?? null, path, monetary: false } },
  );
}

export function assertLeagueNonMonetary(input: {
  entryFeeBaseUnits?: number;
  prizePoolBaseUnits?: number;
}): void {
  if ((input.entryFeeBaseUnits ?? 0) !== 0 || (input.prizePoolBaseUnits ?? 0) !== 0) {
    throw new AppError(
      "LEAGUE_ECONOMICS",
      400,
      "Private leagues must have entry fee 0 and prize pool 0",
    );
  }
}
