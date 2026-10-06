import type { AccountRepository, RequestContext } from "../auth/types.js";
import type { AuditStore } from "../audit/types.js";
import type { FreeResultStore } from "../contests/free/results.js";
import type { ContestStore } from "../contests/store.js";
import type { LeagueStore } from "../leagues/memory-store.js";
import { sanitizeDisplayName } from "./sanitize.js";
import type { PlayerProfile, ProfileRecentContest } from "./types.js";

export class ProfileService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly audit: AuditStore,
    private readonly freeResults: FreeResultStore | null,
    private readonly contests: ContestStore | null,
    private readonly leagues: LeagueStore | null,
  ) {}

  async getByWallet(wallet: string): Promise<PlayerProfile> {
    const account = await this.accounts.findByWallet(wallet);
    const recent: ProfileRecentContest[] = [];

    if (this.freeResults && this.contests) {
      // Pull confirmed free entries then attach final results when present.
      const entries = await this.contests.listConfirmedEntriesForWallet(wallet);
      for (const entry of entries) {
        const contest = await this.contests.getContest(entry.contestId);
        if (!contest || contest.contestKind !== "FREE") continue;
        const result = await this.freeResults.getByContest(contest.id);
        if (!result) continue;
        const row = result.rows.find((r) => r.wallet === wallet);
        if (!row) continue;
        recent.push({
          kind: "FREE_CONTEST",
          id: contest.id,
          label: contest.rulesSnapshot.templateCode,
          matchId: contest.matchId,
          rank: row.rank,
          scoreMilliPoints: row.finalScoreMilliPoints,
          finalizedAt: result.finalizedAt,
          free: true,
          monetary: false,
        });
      }
    }

    if (this.leagues) {
      const leagueResults = await this.leagues.listResultsForWallet(wallet);
      for (const result of leagueResults) {
        const league = await this.leagues.getById(result.leagueId);
        const row = result.rows.find((r) => r.wallet === wallet);
        if (!row || !league) continue;
        recent.push({
          kind: "PRIVATE_LEAGUE",
          id: league.id,
          label: league.name,
          matchId: league.matchId,
          rank: row.rank,
          scoreMilliPoints: row.finalScoreMilliPoints,
          finalizedAt: result.finalizedAt,
          free: true,
          monetary: false,
        });
      }
    }

    recent.sort((a, b) => b.finalizedAt.localeCompare(a.finalizedAt));
    const contestsPlayed = recent.length;
    const wins = recent.filter((r) => r.rank === 1).length;
    const top3Finishes = recent.filter((r) => r.rank <= 3).length;
    const averagePoints =
      contestsPlayed === 0
        ? 0
        : Math.round(recent.reduce((sum, r) => sum + r.scoreMilliPoints, 0) / contestsPlayed) / 1000;

    return {
      wallet,
      displayName: account?.displayName ?? null,
      contestsPlayed,
      wins,
      top3Finishes,
      averagePoints,
      recentContests: recent.slice(0, 10),
      freeOnly: true,
      monetaryStats: false,
    };
  }

  async updateDisplayName(
    accountId: string,
    wallet: string,
    rawName: string,
    ctx: RequestContext,
  ): Promise<PlayerProfile> {
    if (!this.accounts.updateDisplayName) {
      throw new Error("Account repository does not support display names");
    }
    const displayName = sanitizeDisplayName(rawName);
    await this.accounts.updateDisplayName(accountId, displayName, ctx.now);
    await this.audit.append({
      action: "PROFILE_UPDATED",
      occurredAt: ctx.now,
      entityType: "ACCOUNT",
      entityId: accountId,
      metadata: { field: "displayName" },
      actorAccountId: accountId,
      actorWallet: wallet,
      correlationId: ctx.correlationId,
    });
    return this.getByWallet(wallet);
  }
}
