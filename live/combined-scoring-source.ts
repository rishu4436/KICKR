import type { ContestStore } from "../contests/store.js";
import type { LeagueStore } from "../leagues/memory-store.js";
import { createContestScoringSource } from "./contest-scoring-source.js";
import type { ContestScoringEntry, ContestScoringSource } from "./pipeline.js";

/**
 * Single scoring subject list for a match: FREE/paid contest entries PLUS
 * private league members. League members reuse the same pipeline identity
 * (entryId = member id, contestId = league id, frozen team_version_id).
 * Never invents a second scoring engine.
 */
export function createCombinedScoringSource(
  contestStore: ContestStore,
  leagueStore: LeagueStore,
): ContestScoringSource {
  const contests = createContestScoringSource(contestStore);
  return {
    async listEntriesForMatch(matchId: string): Promise<ContestScoringEntry[]> {
      const contestEntries = await contests.listEntriesForMatch(matchId);
      const leagues = await leagueStore.listByMatch(matchId);
      const leagueEntries: ContestScoringEntry[] = [];
      for (const league of leagues) {
        const members = await leagueStore.listMembers(league.id);
        for (const member of members) {
          leagueEntries.push({
            entryId: member.id,
            contestId: league.id,
            wallet: member.wallet,
            teamVersionId: member.teamVersionId,
            // Confirmed on join — same scoring eligibility as FREE contest seats.
            status: "CONFIRMED",
          });
        }
      }
      return [...contestEntries, ...leagueEntries];
    },
  };
}
