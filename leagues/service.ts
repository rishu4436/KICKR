import type { AuditStore } from "../audit/types.js";
import type { RequestContext } from "../auth/types.js";
import { classifyContestLifecycle } from "../domain/football/presentation.js";
import type { FootballService } from "../football/service.js";
import { AppError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { generateInviteCode, invitePath, normalizeInviteCode } from "./invite.js";
import type { LeagueStore } from "./memory-store.js";
import { assertLeagueNonMonetary } from "./money-guard.js";
import { sanitizeLeagueName } from "./sanitize.js";
import type {
  PrivateLeagueLeaderboardRow,
  PrivateLeagueResult,
  PrivateLeagueResultRow,
  PrivateLeagueView,
} from "./types.js";

function rankRows(
  scores: Array<{ memberId: string; wallet: string; teamVersionId: string; finalScoreMilliPoints: number }>,
): PrivateLeagueResultRow[] {
  const sorted = [...scores].sort((a, b) => {
    if (b.finalScoreMilliPoints !== a.finalScoreMilliPoints) {
      return b.finalScoreMilliPoints - a.finalScoreMilliPoints;
    }
    return a.memberId.localeCompare(b.memberId);
  });
  return sorted.map((row, index) => ({
    memberId: row.memberId,
    wallet: row.wallet,
    teamVersionId: row.teamVersionId,
    finalScoreMilliPoints: row.finalScoreMilliPoints,
    rank: index + 1,
  }));
}

export class LeagueService {
  constructor(
    private readonly store: LeagueStore,
    private readonly football: FootballService,
    private readonly audit: AuditStore,
  ) {}

  private async toView(
    league: Awaited<ReturnType<LeagueStore["getById"]>> & object,
    viewerWallet: string | null,
  ): Promise<PrivateLeagueView> {
    const match = await this.football.getMatch(league.matchId);
    const result = await this.store.getResult(league.id);
    const lifecycleBucket = classifyContestLifecycle({
      matchStatus: match?.status ?? null,
      hasFinalResult: result != null,
    });
    const youJoined =
      viewerWallet != null
        ? (await this.store.getMember(league.id, viewerWallet)) != null
        : false;
    return {
      id: league.id,
      name: league.name,
      matchId: league.matchId,
      ownerWallet: league.ownerWallet,
      ownerAccountId: league.ownerAccountId,
      inviteCode: league.inviteCode,
      invitePath: invitePath(league.inviteCode),
      capacity: league.capacity,
      memberCount: league.memberCount,
      remaining: Math.max(0, league.capacity - league.memberCount),
      status: league.status,
      createdAt: league.createdAt,
      lifecycleBucket,
      isOwner: viewerWallet != null && viewerWallet === league.ownerWallet,
      youJoined,
      free: true,
      monetary: false,
      payment: "FREE_NO_PAYMENT",
    };
  }

  async create(
    input: {
      name: string;
      matchId: string;
      capacity: number;
      accountId: string;
      wallet: string;
    },
    ctx: RequestContext,
  ): Promise<PrivateLeagueView> {
    assertLeagueNonMonetary({ entryFeeBaseUnits: 0, prizePoolBaseUnits: 0 });
    const name = sanitizeLeagueName(input.name);
    if (!Number.isInteger(input.capacity) || input.capacity < 2 || input.capacity > 50) {
      throw new AppError("VALIDATION", 400, "Capacity must be an integer from 2 to 50");
    }
    const match = await this.football.getMatch(input.matchId);
    if (!match) {
      throw new AppError("NOT_FOUND", 404, "Match not found");
    }
    const bucket = classifyContestLifecycle({ matchStatus: match.status, hasFinalResult: false });
    if (bucket === "completed") {
      throw new AppError("LEAGUE_MATCH_CLOSED", 409, "Cannot create a league on a completed match");
    }
    let inviteCode = generateInviteCode();
    let league = null as Awaited<ReturnType<LeagueStore["createLeague"]>> | null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        league = await this.store.createLeague({
          name,
          matchId: input.matchId,
          ownerAccountId: input.accountId,
          ownerWallet: input.wallet,
          inviteCode,
          capacity: input.capacity,
          now: ctx.now,
        });
        break;
      } catch (error) {
        if (error instanceof AppError && error.code === "INVITE_COLLISION") {
          inviteCode = generateInviteCode();
          continue;
        }
        throw error;
      }
    }
    if (!league) {
      throw new AppError("INTERNAL", 500, "Could not allocate invite code", { expose: false });
    }
    await this.audit.append({
      action: "LEAGUE_CREATED",
      occurredAt: ctx.now,
      entityType: "LEAGUE",
      entityId: league.id,
      metadata: {
        matchId: league.matchId,
        capacity: league.capacity,
        free: true,
        monetary: false,
      },
      actorAccountId: input.accountId,
      actorWallet: input.wallet,
      correlationId: ctx.correlationId,
    });
    return this.toView(league, input.wallet);
  }

  async get(leagueId: string, viewerWallet: string | null): Promise<PrivateLeagueView> {
    const league = await this.store.getById(leagueId);
    if (!league) throw new AppError("NOT_FOUND", 404, "Not found");
    return this.toView(league, viewerWallet);
  }

  async previewInvite(code: string, viewerWallet: string | null): Promise<PrivateLeagueView> {
    const invite = normalizeInviteCode(code);
    if (invite.length < 6) {
      throw new AppError("INVALID_INVITE", 404, "Invalid invite code");
    }
    const league = await this.store.getByInviteCode(invite);
    if (!league) {
      throw new AppError("INVALID_INVITE", 404, "Invalid invite code");
    }
    return this.toView(league, viewerWallet);
  }

  async join(
    input: {
      inviteCode: string;
      accountId: string;
      wallet: string;
      teamVersionId: string;
    },
    ctx: RequestContext,
  ): Promise<{ league: PrivateLeagueView; memberId: string }> {
    assertLeagueNonMonetary({ entryFeeBaseUnits: 0, prizePoolBaseUnits: 0 });
    const invite = normalizeInviteCode(input.inviteCode);
    const league = await this.store.getByInviteCode(invite);
    if (!league) {
      throw new AppError("INVALID_INVITE", 404, "Invalid invite code");
    }
    const owned = await this.football.getVersionForAccount(input.teamVersionId, input.accountId);
    if (!owned) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    if (!owned.version.validationResult.valid) {
      throw new AppError("FANTASY_TEAM_INVALID", 400, "Fantasy team is invalid");
    }
    if (owned.version.matchId !== league.matchId || owned.team.matchId !== league.matchId) {
      throw new AppError("TEAM_MATCH_MISMATCH", 409, "Team does not belong to this match");
    }
    const match = await this.football.getMatch(league.matchId);
    const bucket = classifyContestLifecycle({
      matchStatus: match?.status ?? null,
      hasFinalResult: (await this.store.getResult(league.id)) != null,
    });
    if (bucket === "completed") {
      throw new AppError("LEAGUE_CLOSED", 409, "League match is completed");
    }
    const joined = await this.store.join({
      leagueId: league.id,
      accountId: input.accountId,
      wallet: input.wallet,
      teamVersionId: input.teamVersionId,
      now: ctx.now,
    });
    await this.audit.append({
      action: "LEAGUE_JOINED",
      occurredAt: ctx.now,
      entityType: "LEAGUE",
      entityId: league.id,
      metadata: {
        memberId: joined.member.id,
        free: true,
        monetary: false,
        payment: "none",
      },
      actorAccountId: input.accountId,
      actorWallet: input.wallet,
      correlationId: ctx.correlationId,
    });
    return {
      league: await this.toView(joined.league, input.wallet),
      memberId: joined.member.id,
    };
  }

  async listMine(wallet: string, accountId: string): Promise<PrivateLeagueView[]> {
    const owned = await this.store.listOwned(accountId);
    const joined = await this.store.listJoined(wallet);
    const byId = new Map<string, (typeof owned)[number]>();
    for (const row of [...owned, ...joined]) {
      byId.set(row.id, row);
    }
    const views: PrivateLeagueView[] = [];
    for (const row of byId.values()) {
      views.push(await this.toView(row, wallet));
    }
    return views;
  }

  async leaderboard(
    leagueId: string,
    viewerWallet: string | null,
    liveScores?: Map<string, number>,
  ): Promise<{
    league: PrivateLeagueView;
    freshness: "LIVE" | "FINAL" | "UNKNOWN";
    rows: PrivateLeagueLeaderboardRow[];
  }> {
    const league = await this.store.getById(leagueId);
    if (!league) throw new AppError("NOT_FOUND", 404, "Not found");
    const view = await this.toView(league, viewerWallet);
    const final = await this.store.getResult(leagueId);
    if (final) {
      return {
        league: view,
        freshness: "FINAL",
        rows: final.rows.map((row) => ({
          rank: row.rank,
          wallet: row.wallet,
          teamVersionId: row.teamVersionId,
          milliPoints: row.finalScoreMilliPoints,
          you: viewerWallet != null && row.wallet === viewerWallet,
        })),
      };
    }
    const members = await this.store.listMembers(leagueId);
    const scored = members.map((m) => ({
      rank: 0,
      wallet: m.wallet,
      teamVersionId: m.teamVersionId,
      milliPoints: liveScores?.get(m.teamVersionId) ?? 0,
      you: viewerWallet != null && m.wallet === viewerWallet,
    }));
    scored.sort((a, b) => {
      if (b.milliPoints !== a.milliPoints) return b.milliPoints - a.milliPoints;
      return a.wallet.localeCompare(b.wallet);
    });
    scored.forEach((row, i) => {
      row.rank = i + 1;
    });
    return {
      league: view,
      freshness: liveScores ? "LIVE" : "UNKNOWN",
      rows: scored,
    };
  }

  async finalize(
    leagueId: string,
    scores: Array<{ memberId: string; wallet: string; teamVersionId: string; finalScoreMilliPoints: number }>,
    ctx: RequestContext,
  ): Promise<PrivateLeagueResult> {
    const league = await this.store.getById(leagueId);
    if (!league) throw new AppError("NOT_FOUND", 404, "Not found");
    const existing = await this.store.getResult(leagueId);
    if (existing) return existing;
    const members = await this.store.listMembers(leagueId);
    const memberIds = new Set(members.map((m) => m.id));
    for (const score of scores) {
      if (!memberIds.has(score.memberId)) {
        throw new AppError("VALIDATION", 400, "Score references unknown member");
      }
    }
    const rows = rankRows(scores);
    const result: PrivateLeagueResult = {
      id: newId(),
      leagueId,
      matchId: league.matchId,
      status: "FINAL",
      rows,
      finalizedAt: ctx.now.toISOString(),
    };
    const saved = await this.store.saveResult(result);
    await this.audit.append({
      action: "LEAGUE_RESULT_FINALIZED",
      occurredAt: ctx.now,
      entityType: "LEAGUE",
      entityId: leagueId,
      metadata: { free: true, monetary: false, entrants: rows.length },
      actorAccountId: null,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });
    return saved;
  }

  async getResult(leagueId: string): Promise<PrivateLeagueResult | null> {
    return this.store.getResult(leagueId);
  }

  async listResultsForWallet(wallet: string): Promise<PrivateLeagueResult[]> {
    return this.store.listResultsForWallet(wallet);
  }
}
