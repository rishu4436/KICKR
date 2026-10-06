/**
 * FREE contest final results: score snapshot + rank only.
 * No Merkle root, no settlement payload, no on-chain commit, no claim.
 */
import { compareTiedEntries } from "../../settlement/tie-policy.js";
import { AppError } from "../../shared/errors.js";
import { newId } from "../../shared/ids.js";
import { isFreeContest } from "../kind.js";
import type { ContestRecord } from "../types.js";

export interface FreeResultRow {
  entryId: string;
  wallet: string;
  teamVersionId: string;
  finalScoreMilliPoints: number;
  rank: number;
}

export interface FreeContestResult {
  id: string;
  contestId: string;
  matchId: string;
  status: "FINAL";
  rows: FreeResultRow[];
  finalizedAt: string;
  /** Explicitly absent — FREE never carries monetary settlement material. */
  merkleRoot: null;
  settlementHash: null;
  claimable: false;
}

export interface FreeResultStore {
  getByContest(contestId: string): Promise<FreeContestResult | null>;
  save(result: FreeContestResult): Promise<FreeContestResult>;
}

export class InMemoryFreeResultStore implements FreeResultStore {
  private readonly byContest = new Map<string, FreeContestResult>();

  async getByContest(contestId: string): Promise<FreeContestResult | null> {
    return this.byContest.get(contestId) ?? null;
  }

  async save(result: FreeContestResult): Promise<FreeContestResult> {
    const copy = structuredClone(result);
    this.byContest.set(result.contestId, copy);
    return structuredClone(copy);
  }
}

export function rankFreeEntries(
  entries: Array<{
    entryId: string;
    wallet: string;
    teamVersionId: string;
    finalScoreMilliPoints: number;
  }>,
): FreeResultRow[] {
  const sorted = entries.slice().sort((a, b) =>
    compareTiedEntries(
      { finalScoreMilliPoints: a.finalScoreMilliPoints, entryId: a.entryId },
      { finalScoreMilliPoints: b.finalScoreMilliPoints, entryId: b.entryId },
    ),
  );
  return sorted.map((row, index) => ({
    entryId: row.entryId,
    wallet: row.wallet,
    teamVersionId: row.teamVersionId,
    finalScoreMilliPoints: row.finalScoreMilliPoints,
    rank: index + 1,
  }));
}

export function finalizeFreeContest(input: {
  contest: ContestRecord;
  scores: Array<{
    entryId: string;
    wallet: string;
    teamVersionId: string;
    finalScoreMilliPoints: number;
  }>;
  nowIso: string;
}): FreeContestResult {
  if (!isFreeContest(input.contest)) {
    throw new AppError("NOT_FREE_CONTEST", 409, "Only FREE contests use free finalization");
  }
  if (input.contest.entryFeeBaseUnits !== 0) {
    throw new AppError("FREE_CONTEST_ECONOMICS", 409, "FREE contests must have entry fee 0");
  }
  const rows = rankFreeEntries(input.scores);
  return {
    id: newId(),
    contestId: input.contest.id,
    matchId: input.contest.matchId,
    status: "FINAL",
    rows,
    finalizedAt: input.nowIso,
    merkleRoot: null,
    settlementHash: null,
    claimable: false,
  };
}

/** my-result claim UI for FREE — never claimable. */
export function freeClaimUiState(hasFinal: boolean): "pending_result" | "final" {
  return hasFinal ? "final" : "pending_result";
}
