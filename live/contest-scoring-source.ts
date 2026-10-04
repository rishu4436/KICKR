import type { ContestStore } from "../contests/store.js";
import type { ContestScoringEntry, ContestScoringSource } from "./pipeline.js";

/**
 * Resolves contest scoring subjects as contest_entries.team_version_id.
 * Fantasy team "latest version" is never consulted here.
 */
export function createContestScoringSource(store: ContestStore): ContestScoringSource {
  return {
    async listEntriesForMatch(matchId: string): Promise<ContestScoringEntry[]> {
      const contests = await store.listByMatch(matchId);
      const entries: ContestScoringEntry[] = [];
      for (const contest of contests) {
        const rows = await store.listEntries(contest.id);
        for (const entry of rows) {
          entries.push({
            entryId: entry.id,
            contestId: entry.contestId,
            wallet: entry.wallet,
            teamVersionId: entry.teamVersionId,
            status: entry.status,
          });
        }
      }
      return entries;
    },
  };
}
