/**
 * Phase 16 onboarding progress. Meaningful steps persist beyond one session:
 * XI saved / contest|league joined derive from account state;
 * leaderboard viewed is stored on the account row.
 * Dismissal preference may remain client-side.
 */
import type { AccountRepository, RequestContext } from "../auth/types.js";
import type { AuditStore } from "../audit/types.js";
import type { ContestStore } from "../contests/store.js";
import type { LeagueService } from "../leagues/service.js";
import type { FootballService } from "../football/service.js";

export interface OnboardingProgress {
  signedIn: true;
  xiSaved: boolean;
  freeJoined: boolean;
  leaderboardViewed: boolean;
  /** sessionStorage must not be authoritative for these. */
  source: "account";
}

export class OnboardingService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly audit: AuditStore,
    private readonly football: FootballService | null,
    private readonly contests: ContestStore | null,
    private readonly leagues: LeagueService | null,
  ) {}

  async getProgress(accountId: string, wallet: string): Promise<OnboardingProgress> {
    const account = await this.accounts.findById(accountId);
    let xiSaved = false;
    if (this.football) {
      try {
        const upcoming = await this.football.listMatches("upcoming");
        const live = await this.football.listMatches("live");
        const candidates = [...upcoming, ...live].slice(0, 8);
        for (const match of candidates) {
          const mine = await this.football.getMyTeamForMatch(accountId, match.id);
          if (mine?.latest?.playerIds?.length === 11) {
            xiSaved = true;
            break;
          }
        }
      } catch {
        xiSaved = false;
      }
    }

    let freeJoined = false;
    if (this.contests) {
      const entries = await this.contests.listConfirmedEntriesForWallet(wallet);
      for (const entry of entries) {
        const contest = await this.contests.getContest(entry.contestId);
        if (contest?.contestKind === "FREE") {
          freeJoined = true;
          break;
        }
      }
    }
    if (!freeJoined && this.leagues) {
      const mine = await this.leagues.listMine(wallet, accountId);
      freeJoined = mine.some((l) => l.youJoined || l.isOwner);
    }

    return {
      signedIn: true,
      xiSaved,
      freeJoined,
      leaderboardViewed: Boolean(account?.onboardingLeaderboardViewedAt),
      source: "account",
    };
  }

  async markLeaderboardViewed(
    accountId: string,
    wallet: string,
    ctx: RequestContext,
  ): Promise<OnboardingProgress> {
    if (!this.accounts.markOnboardingLeaderboardViewed) {
      throw new Error("Account repository does not support onboarding progress");
    }
    await this.accounts.markOnboardingLeaderboardViewed(accountId, ctx.now);
    await this.audit.append({
      action: "ONBOARDING_LEADERBOARD_VIEWED",
      occurredAt: ctx.now,
      entityType: "ACCOUNT",
      entityId: accountId,
      metadata: { field: "onboardingLeaderboardViewedAt" },
      actorAccountId: accountId,
      actorWallet: wallet,
      correlationId: ctx.correlationId,
    });
    return this.getProgress(accountId, wallet);
  }
}
