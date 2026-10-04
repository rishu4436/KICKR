/**
 * Explicit Phase 6 tie policy.
 *
 * When final milli-points are equal, order by entry_id ascending (UUID string
 * lexicographic compare). The lower entry_id receives the better (lower) rank.
 * Ranks are unique. Prize allocation uses these unique ranks against the frozen
 * payout policy. This is not a silent default — see docs/phase-6-settlement.md.
 */
export const TIE_POLICY_ID = "entry_id_asc" as const;

export function compareTiedEntries(
  a: { finalScoreMilliPoints: number; entryId: string },
  b: { finalScoreMilliPoints: number; entryId: string },
): number {
  if (b.finalScoreMilliPoints !== a.finalScoreMilliPoints) {
    return b.finalScoreMilliPoints - a.finalScoreMilliPoints;
  }
  if (a.entryId < b.entryId) {
    return -1;
  }
  if (a.entryId > b.entryId) {
    return 1;
  }
  return 0;
}
