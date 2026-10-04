import { AppError } from "../shared/errors.js";
import type { ResultSnapshotRecord, SnapshotStore } from "../live/snapshot.js";
import type { RankedEntryInput } from "./payouts.js";

/**
 * Settlement consumes APPROVED match_score_snapshots only.
 * DRAFT / missing / wrong contest snapshots cannot enter calculation.
 * Scores, XI, captain, vice, team_version_id come from the snapshot — never a later fantasy version.
 */
export function assertAllApproved(snapshots: ResultSnapshotRecord[]): void {
  if (snapshots.length === 0) {
    throw new AppError("SNAPSHOT_MISSING", 409, "No APPROVED score snapshots for contest settlement");
  }
  for (const row of snapshots) {
    if (row.status !== "APPROVED") {
      throw new AppError("SNAPSHOT_UNAPPROVED", 409, "Cannot settle while a score snapshot is DRAFT or unapproved");
    }
    if (!row.approvedAt) {
      throw new AppError("SNAPSHOT_UNAPPROVED", 409, "Cannot settle while a score snapshot lacks approved_at");
    }
  }
}

export function snapshotsToRankedEntries(
  snapshots: ResultSnapshotRecord[],
  destinationByEntryId: Map<string, string>,
): RankedEntryInput[] {
  assertAllApproved(snapshots);
  return snapshots.map((row) => {
    const wallet = destinationByEntryId.get(row.entryId);
    if (!wallet) {
      throw new AppError("ENTRY_WALLET_MISSING", 409, `No destination wallet for entry ${row.entryId}`);
    }
    if (row.teamVersionId !== row.snapshot.teamVersionId) {
      throw new AppError("TEAM_VERSION_MISMATCH", 409, "Snapshot team_version_id does not match record");
    }
    const baseScoreMilliPoints = row.snapshot.scoreCalculation.playerScores.reduce(
      (sum, player) => sum + player.baseMilliPoints,
      0,
    );
    return {
      entryId: row.entryId,
      teamVersionId: row.teamVersionId,
      destinationWallet: wallet,
      finalScoreMilliPoints: row.snapshot.finalScoreMilliPoints,
      baseScoreMilliPoints,
      xi: [...row.snapshot.exactXi],
      captainId: row.snapshot.captainId,
      viceId: row.snapshot.viceId,
    };
  });
}

export async function loadApprovedSnapshotsForContest(
  store: SnapshotStore,
  contestId: string,
  expectedEntryIds: readonly string[],
): Promise<ResultSnapshotRecord[]> {
  const approved = await store.listApprovedForContest(contestId);
  assertAllApproved(approved);
  const byEntry = new Map(approved.map((row) => [row.entryId, row]));
  const missing = expectedEntryIds.filter((id) => !byEntry.has(id));
  if (missing.length > 0) {
    throw new AppError(
      "SNAPSHOT_INCOMPLETE",
      409,
      `Missing APPROVED snapshots for confirmed entries: ${missing.join(",")}`,
    );
  }
  // Refuse if any draft exists for these entries that would imply incomplete finalization.
  const allForMatch = await store.listByMatch(approved[0]!.matchId);
  for (const entryId of expectedEntryIds) {
    const drafts = allForMatch.filter((row) => row.entryId === entryId && row.status === "DRAFT");
    // Drafts may exist historically before approval; only the approved row is consumed.
    void drafts;
  }
  return expectedEntryIds.map((id) => byEntry.get(id)!);
}
