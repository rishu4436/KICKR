/**
 * Contest-scoped ranking shared by live boards and FREE finalization.
 * Tie policy: entry_id_asc (lower entry_id wins the better rank when scores tie).
 */
import { compareTiedEntries } from "../settlement/tie-policy.js";

export interface RankableEntry {
  entryId: string;
  milliPoints: number;
}

export interface RankedEntry<T extends RankableEntry> extends RankableEntry {
  rank: number;
  source: T;
}

/**
 * Sort by milli-points desc, then entry_id asc; assign unique ranks 1..n.
 * Same ordering as contests/free/results.rankFreeEntries.
 */
export function rankWithinContestScope<T extends RankableEntry>(
  rows: readonly T[],
): Array<RankedEntry<T>> {
  const sorted = rows.slice().sort((a, b) =>
    compareTiedEntries(
      { finalScoreMilliPoints: a.milliPoints, entryId: a.entryId },
      { finalScoreMilliPoints: b.milliPoints, entryId: b.entryId },
    ),
  );
  return sorted.map((row, index) => ({
    entryId: row.entryId,
    milliPoints: row.milliPoints,
    rank: index + 1,
    source: row,
  }));
}

/** Filter a mixed match board to one contest and re-rank within that contest. */
export function filterAndRerankContestRows<
  T extends RankableEntry & { contestId: string },
>(rows: readonly T[], contestId: string): Array<RankedEntry<T>> {
  return rankWithinContestScope(rows.filter((row) => row.contestId === contestId));
}
