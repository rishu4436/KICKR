/**
 * Contest kind boundary. FREE is the Phase 11 product path.
 * PAID_DEVNET is the existing escrow/devnet path and stays disabled in production.
 * Module boundary: money paths must call assertPaidMoneyPath / rejectFreeMoneyPath.
 */
import { AppError } from "../shared/errors.js";

export const CONTEST_KINDS = ["FREE", "PAID_DEVNET"] as const;
export type ContestKind = (typeof CONTEST_KINDS)[number];

export function isContestKind(value: unknown): value is ContestKind {
  return value === "FREE" || value === "PAID_DEVNET";
}

export function parseContestKind(value: unknown, fallback: ContestKind = "PAID_DEVNET"): ContestKind {
  if (isContestKind(value)) {
    return value;
  }
  return fallback;
}

/** Prefer explicit kind; never invent FREE from a positive fee. */
export function resolveContestKind(input: {
  contestKind?: ContestKind | null;
  rulesSnapshot?: { contestKind?: ContestKind | null } | null;
  entryFeeBaseUnits?: number;
}): ContestKind {
  if (isContestKind(input.contestKind)) {
    return input.contestKind;
  }
  if (isContestKind(input.rulesSnapshot?.contestKind)) {
    return input.rulesSnapshot!.contestKind!;
  }
  // Legacy rows without kind: fee 0 alone is not enough to claim FREE (fail closed for money).
  return "PAID_DEVNET";
}

export function isFreeContest(input: {
  contestKind?: ContestKind | null;
  rulesSnapshot?: { contestKind?: ContestKind | null } | null;
}): boolean {
  return resolveContestKind(input) === "FREE";
}

export function isPaidDevnetContest(input: {
  contestKind?: ContestKind | null;
  rulesSnapshot?: { contestKind?: ContestKind | null } | null;
}): boolean {
  return resolveContestKind(input) === "PAID_DEVNET";
}

/**
 * Fail-closed guard for every monetary / escrow / settlement / claim path.
 * FREE contests must never enter these endpoints.
 */
export function rejectFreeMoneyPath(
  contest: {
    contestKind?: ContestKind | null;
    rulesSnapshot?: { contestKind?: ContestKind | null } | null;
    entryFeeBaseUnits?: number;
    id?: string;
  },
  path: string,
): void {
  if (isFreeContest(contest)) {
    throw new AppError(
      "FREE_CONTEST_MONEY_FORBIDDEN",
      409,
      `FREE contests cannot use ${path}`,
      { details: { contestId: contest.id ?? null, path, contestKind: "FREE" } },
    );
  }
}

/** FREE templates/contests must have zero entry fee and zero prize pool. */
export function assertFreeEconomics(input: {
  contestKind: ContestKind;
  entryFeeBaseUnits: number;
  prizePoolBaseUnits: number;
}): void {
  if (input.contestKind !== "FREE") {
    return;
  }
  if (input.entryFeeBaseUnits !== 0 || input.prizePoolBaseUnits !== 0) {
    throw new AppError(
      "FREE_CONTEST_ECONOMICS",
      400,
      "FREE contests must have entry fee 0 and prize pool 0",
    );
  }
}
