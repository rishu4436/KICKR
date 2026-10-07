import type { RequestContext } from "../auth/types.js";
import type { AuditStore } from "../audit/types.js";
import type { FootballService } from "../football/service.js";
import type { RedisClient } from "../redis/client.js";
import type { ProviderIdMap } from "../sports/id-map.js";
import { LiveScoreCache } from "./cache.js";
import { LiveScoreHub } from "./hub.js";
import { LiveMetrics } from "./metrics.js";
import { LiveScoringPipeline, type ContestScoringSource, type LivePipelineStore } from "./pipeline.js";
import { DEV_V1_RULESET, DEV_V1_SCALE, type ScoringRuleset } from "../domain/scoring/dev-v1.js";
import { derivePitchStates, type LineupSeed } from "./lineup.js";
import {
  computeScoreSnapshotId,
  eventLogFingerprint,
  isScoreSnapshotFresh,
} from "./score-snapshot.js";
import { filterAndRerankContestRows } from "./contest-rank.js";

export class LiveScoringService {
  readonly cache: LiveScoreCache;
  readonly hub: LiveScoreHub;
  readonly metrics: LiveMetrics;
  readonly pipeline: LiveScoringPipeline;

  constructor(
    private readonly store: LivePipelineStore,
    private readonly football: FootballService,
    idMap: ProviderIdMap,
    redis: RedisClient,
    env: string,
    audit: AuditStore,
    providerName: string,
    contestSource: ContestScoringSource | null = null,
    ruleset: ScoringRuleset = DEV_V1_RULESET,
  ) {
    this.cache = new LiveScoreCache(redis, env);
    this.hub = new LiveScoreHub();
    this.metrics = new LiveMetrics();
    this.metrics.setProvider(providerName, providerName !== "none" && providerName !== "");
    this.pipeline = new LiveScoringPipeline(
      store,
      idMap,
      this.cache,
      this.hub,
      this.metrics,
      audit,
      providerName,
      contestSource,
      ruleset,
    );
  }

  getRuleset(): ScoringRuleset {
    return this.pipeline.getRuleset();
  }

  async getMatchLive(matchId: string, ctx: RequestContext) {
    const match = await this.football.getMatch(matchId);
    if (!match) {
      return null;
    }
    const expected = await this.expectedScoreSnapshotId(matchId);
    let cached = await this.cache.readMatch(matchId);
    if (!cached || !isScoreSnapshotFresh(cached.scoreSnapshotId, expected.scoreSnapshotId)) {
      const rebuilt = await this.pipeline.rebuildFromEvents(matchId, ctx);
      cached = await this.cache.readMatch(matchId);
      if (!cached) {
        return {
          matchId,
          freshness: rebuilt.freshness,
          timestamps: { updatedAt: ctx.now.toISOString(), lastEventAt: rebuilt.lastEventAt },
          eventCount: rebuilt.eventCount,
          providerName: this.metrics.snapshot().providerName,
          playerScores: rebuilt.playerScores,
          scale: this.pipeline.getRuleset().scale,
          ruleset: { name: this.pipeline.getRuleset().name, status: this.pipeline.getRuleset().status },
          scoreSnapshotId: expected.scoreSnapshotId,
          dataHealth: {
            connected: rebuilt.freshness !== "DATA_ERROR",
            delayed: rebuilt.freshness === "STALE",
            lastEventAgeMs: rebuilt.lastEventAt
              ? ctx.now.getTime() - Date.parse(rebuilt.lastEventAt)
              : null,
            providerName: this.metrics.snapshot().providerName,
            eventCount: rebuilt.eventCount,
          },
        };
      }
    }
    const lastEventAgeMs = cached.lastEventAt
      ? ctx.now.getTime() - Date.parse(cached.lastEventAt)
      : null;
    return {
      matchId,
      freshness: cached.freshness,
      timestamps: { updatedAt: cached.updatedAt, lastEventAt: cached.lastEventAt },
      eventCount: cached.eventCount,
      providerName: cached.providerName,
      playerScores: cached.playerScores,
      scale: this.pipeline.getRuleset().scale,
      ruleset: { name: this.pipeline.getRuleset().name, status: this.pipeline.getRuleset().status },
      scoreSnapshotId: cached.scoreSnapshotId ?? expected.scoreSnapshotId,
      dataHealth: {
        connected: cached.freshness !== "DATA_ERROR",
        delayed: cached.freshness === "STALE",
        lastEventAgeMs,
        providerName: cached.providerName,
        eventCount: cached.eventCount,
      },
    };
  }

  async getMatchEvents(matchId: string) {
    const match = await this.football.getMatch(matchId);
    if (!match) {
      return null;
    }
    const events = await this.store.listEvents(matchId);
    const squad = await this.store.listSquad(matchId);
    const players = await this.store.listPlayers();
    const byId = new Map(players.map((player) => [player.id, player]));
    const seeds: LineupSeed[] = squad.map((row) => ({
      playerId: row.playerId,
      clubId: row.clubId,
      position: byId.get(row.playerId)?.position ?? row.fantasyPosition,
      startingStatus: row.startingStatus,
      availability: row.availability,
      squadStatus: row.squadStatus,
    }));
    const pitch = derivePitchStates(seeds, events);
    return {
      matchId,
      events: events.map((event) => ({
        eventId: event.eventId,
        provider: event.provider,
        providerEventId: event.providerEventId,
        sequence: event.sequence,
        timestamp: event.timestamp,
        matchMinute: event.matchMinute,
        period: event.period,
        eventType: event.eventType,
        primaryPlayerId: event.primaryPlayerId,
        secondaryPlayerId: event.secondaryPlayerId,
        teamId: event.teamId,
        supersedesEventId: event.supersedesEventId,
        correctionType: event.correctionType ?? null,
        metadata: event.metadata,
      })),
      lineupDerived: [...pitch.values()],
    };
  }

  /**
   * Postgres event log + contest entries are authoritative.
   * Redis leaderboard is served only when scoreSnapshotId still matches.
   * A newer scoring wave (new events or new entries) invalidates the cache automatically —
   * callers never need a harness-forced rebuild for freshness.
   */
  async getLeaderboard(matchId: string, ctx: RequestContext) {
    const match = await this.football.getMatch(matchId);
    if (!match) {
      return null;
    }
    const expected = await this.expectedScoreSnapshotId(matchId);
    let board = await this.cache.readLeaderboard(matchId);
    let rebuiltLeaderboard: Awaited<ReturnType<LiveScoringPipeline["rebuildFromEvents"]>>["leaderboard"] | null =
      null;
    if (!board || !isScoreSnapshotFresh(board.scoreSnapshotId, expected.scoreSnapshotId)) {
      const rebuilt = await this.pipeline.rebuildFromEvents(matchId, ctx);
      rebuiltLeaderboard = rebuilt.leaderboard;
      board = await this.cache.readLeaderboard(matchId);
      if (!board) {
        board = {
          matchId,
          contestId: rebuilt.leaderboard[0]?.contestId ?? null,
          rows: rebuilt.leaderboard.map((row) => ({
            entryId: row.entryId,
            contestId: row.contestId,
            teamVersionId: row.teamVersionId,
            wallet: row.wallet,
            milliPoints: row.milliPoints,
            rank: row.rank,
            priorRank: row.priorRank,
            scoreDelta: row.scoreDelta,
            teamId: row.entryId,
            accountId: row.wallet,
          })),
          updatedAt: ctx.now.toISOString(),
          freshness: rebuilt.freshness,
          scoreSnapshotId: expected.scoreSnapshotId,
          eventCount: expected.eventCount,
          lastEventAt: expected.lastEventAt,
        };
      }
    }
    const leaderboard =
      rebuiltLeaderboard ??
      board.rows.map((row) => ({
        entryId: row.entryId ?? row.teamId ?? "",
        contestId: row.contestId || board?.contestId || "",
        teamVersionId: row.teamVersionId ?? "",
        wallet: row.wallet || row.accountId || "",
        milliPoints: row.milliPoints,
        rank: row.rank,
        priorRank: row.priorRank ?? null,
        scoreDelta: row.scoreDelta ?? null,
      }));
    return {
      matchId,
      freshness: board.freshness,
      timestamps: { updatedAt: board.updatedAt, lastEventAt: board.lastEventAt ?? expected.lastEventAt },
      scale: DEV_V1_SCALE,
      scoreSnapshotId: board.scoreSnapshotId ?? expected.scoreSnapshotId,
      eventCount: board.eventCount ?? expected.eventCount,
      leaderboard,
      note: "Contest leaderboard rows are keyed by contest entry and frozen team_version_id, not fantasy team latest. Cache is invalidated when scoreSnapshotId diverges from Postgres.",
    };
  }

  /** Authoritative score-snapshot etag from Postgres event log + scoring entries. */
  private async expectedScoreSnapshotId(matchId: string): Promise<{
    scoreSnapshotId: string;
    eventCount: number;
    lastEventAt: string | null;
  }> {
    const events = await this.store.listEvents(matchId);
    const fingerprint = eventLogFingerprint(events);
    const entryIds = await this.pipeline.listScoringEntryIds(matchId);
    return {
      scoreSnapshotId: computeScoreSnapshotId({
        eventCount: fingerprint.eventCount,
        lastEventAt: fingerprint.lastEventAt,
        lastEventId: fingerprint.lastEventId,
        entryIds,
      }),
      eventCount: fingerprint.eventCount,
      lastEventAt: fingerprint.lastEventAt,
    };
  }

  /**
   * FREE/paid contest leaderboard: ranks only entries for the selected contest.
   * Match-level Redis board may mix contests; this view always re-ranks within contest.
   * Postgres event log + contest entry ids are the scoreSnapshotId; Redis is cache-only.
   */
  async getContestLeaderboard(
    input: {
      contestId: string;
      matchId: string;
    },
    ctx: RequestContext,
  ) {
    const match = await this.football.getMatch(input.matchId);
    if (!match) {
      return null;
    }
    const events = await this.store.listEvents(input.matchId);
    const fingerprint = eventLogFingerprint(events);
    const matchBoard = await this.getLeaderboard(input.matchId, ctx);
    if (!matchBoard) {
      return null;
    }
    const contestRows = matchBoard.leaderboard.filter((row) => row.contestId === input.contestId);
    const entryIds = contestRows.map((row) => row.entryId).sort();
    const expectedSnapshotId = computeScoreSnapshotId({
      eventCount: fingerprint.eventCount,
      lastEventAt: fingerprint.lastEventAt,
      lastEventId: fingerprint.lastEventId,
      entryIds,
    });

    let contestBoard = await this.cache.readContestLeaderboard(input.contestId);
    const priorByEntry = new Map(
      (contestBoard?.rows ?? []).map((row) => {
        const entryId = row.entryId ?? row.teamId ?? "";
        return [entryId, { rank: row.rank, milliPoints: row.milliPoints }] as const;
      }),
    );
    if (!contestBoard || !isScoreSnapshotFresh(contestBoard.scoreSnapshotId, expectedSnapshotId)) {
      await this.cache.clearContestLeaderboard(input.contestId);
      const ranked = filterAndRerankContestRows(matchBoard.leaderboard, input.contestId).map((rankedRow) => {
        const prior = priorByEntry.get(rankedRow.entryId);
        const source = rankedRow.source;
        return {
          entryId: source.entryId,
          contestId: source.contestId,
          teamVersionId: source.teamVersionId,
          wallet: source.wallet,
          milliPoints: source.milliPoints,
          rank: rankedRow.rank,
          priorRank: prior?.rank ?? null,
          scoreDelta: prior ? source.milliPoints - prior.milliPoints : source.scoreDelta ?? null,
        };
      });
      contestBoard = {
        matchId: input.matchId,
        contestId: input.contestId,
        rows: ranked.map((row) => ({
          entryId: row.entryId,
          contestId: row.contestId,
          teamVersionId: row.teamVersionId,
          wallet: row.wallet,
          milliPoints: row.milliPoints,
          rank: row.rank,
          priorRank: row.priorRank,
          scoreDelta: row.scoreDelta,
          teamId: row.entryId,
          accountId: row.wallet,
        })),
        updatedAt: ctx.now.toISOString(),
        freshness: matchBoard.freshness,
        scoreSnapshotId: expectedSnapshotId,
        eventCount: fingerprint.eventCount,
        lastEventAt: fingerprint.lastEventAt,
      };
      await this.cache.writeContestLeaderboard(input.contestId, contestBoard);
    }

    return {
      contestId: input.contestId,
      matchId: input.matchId,
      freshness: contestBoard.freshness,
      timestamps: { updatedAt: contestBoard.updatedAt, lastEventAt: contestBoard.lastEventAt },
      scale: DEV_V1_SCALE,
      scoreSnapshotId: contestBoard.scoreSnapshotId,
      eventCount: contestBoard.eventCount,
      leaderboard: contestBoard.rows.map((row) => ({
        entryId: row.entryId ?? row.teamId ?? "",
        contestId: row.contestId || input.contestId,
        teamVersionId: row.teamVersionId ?? "",
        wallet: row.wallet || row.accountId || "",
        milliPoints: row.milliPoints,
        rank: row.rank,
        priorRank: row.priorRank ?? null,
        scoreDelta: row.scoreDelta ?? null,
      })),
      note: "Contest ranks include only this contest's entries (entry_id_asc ties). Redis is cache-only.",
    };
  }

  /**
   * Private league leaderboard reuses the match pipeline scores.
   * Postgres event log + league membership entry ids are the scoreSnapshotId.
   * Stale Redis league cache is discarded when the snapshot diverges.
   * Ranks are within the league only (not mixed with other contests).
   */
  async getLeagueLeaderboard(
    input: {
      leagueId: string;
      matchId: string;
      memberEntryIds: readonly string[];
    },
    ctx: RequestContext,
  ) {
    const match = await this.football.getMatch(input.matchId);
    if (!match) {
      return null;
    }
    const events = await this.store.listEvents(input.matchId);
    const fingerprint = eventLogFingerprint(events);
    const entryIds = [...input.memberEntryIds].sort();
    const expectedSnapshotId = computeScoreSnapshotId({
      eventCount: fingerprint.eventCount,
      lastEventAt: fingerprint.lastEventAt,
      lastEventId: fingerprint.lastEventId,
      entryIds,
    });

    let leagueBoard = await this.cache.readLeagueLeaderboard(input.leagueId);
    if (!leagueBoard || !isScoreSnapshotFresh(leagueBoard.scoreSnapshotId, expectedSnapshotId)) {
      // Discard stale league cache; rebuild from the shared pipeline.
      await this.cache.clearLeagueLeaderboard(input.leagueId);
      const matchBoard = await this.getLeaderboard(input.matchId, ctx);
      if (!matchBoard) {
        return null;
      }
      const memberSet = new Set(entryIds);
      const scoped = matchBoard.leaderboard.filter(
        (row) => row.contestId === input.leagueId && memberSet.has(row.entryId),
      );
      const filtered = filterAndRerankContestRows(scoped, input.leagueId).map((ranked) => ({
        ...ranked.source,
        rank: ranked.rank,
      }));
      leagueBoard = {
        matchId: input.matchId,
        contestId: input.leagueId,
        rows: filtered.map((row) => ({
          entryId: row.entryId,
          contestId: row.contestId,
          teamVersionId: row.teamVersionId,
          wallet: row.wallet,
          milliPoints: row.milliPoints,
          rank: row.rank,
          priorRank: row.priorRank,
          scoreDelta: row.scoreDelta,
          teamId: row.entryId,
          accountId: row.wallet,
        })),
        updatedAt: ctx.now.toISOString(),
        freshness: matchBoard.freshness,
        scoreSnapshotId: expectedSnapshotId,
        eventCount: fingerprint.eventCount,
        lastEventAt: fingerprint.lastEventAt,
      };
      await this.cache.writeLeagueLeaderboard(input.leagueId, leagueBoard);
    }

    return {
      leagueId: input.leagueId,
      matchId: input.matchId,
      freshness: leagueBoard.freshness,
      timestamps: { updatedAt: leagueBoard.updatedAt, lastEventAt: leagueBoard.lastEventAt },
      scale: DEV_V1_SCALE,
      scoreSnapshotId: leagueBoard.scoreSnapshotId,
      eventCount: leagueBoard.eventCount,
      leaderboard: leagueBoard.rows.map((row) => ({
        entryId: row.entryId ?? row.teamId ?? "",
        contestId: row.contestId || input.leagueId,
        teamVersionId: row.teamVersionId ?? "",
        wallet: row.wallet || row.accountId || "",
        milliPoints: row.milliPoints,
        rank: row.rank,
        priorRank: row.priorRank ?? null,
        scoreDelta: row.scoreDelta ?? null,
      })),
      note: "League ranks reuse FREE contest scoring (same event log, rules, snapshot identity). Redis is cache-only.",
    };
  }

  async getTeamLiveScore(teamId: string, accountId: string, ctx: RequestContext) {
    const owned = await this.football.getTeamForAccount(teamId, accountId);
    if (!owned) {
      return null;
    }
    let cached = await this.cache.readTeam(teamId);
    if (!cached) {
      await this.pipeline.rebuildFromEvents(owned.team.matchId, ctx);
      cached = await this.cache.readTeam(teamId);
    }
    if (!cached) {
      return {
        teamId,
        matchId: owned.team.matchId,
        freshness: "LIVE" as const,
        timestamps: { updatedAt: ctx.now.toISOString() },
        milliPoints: 0,
        scale: DEV_V1_SCALE,
        players: [],
        explanationNote:
          "Player baseMilliPoints are before captain/vice. milliPoints include the multiplier applied once at team rollup.",
      };
    }
    return {
      teamId: cached.teamId,
      matchId: cached.matchId,
      freshness: "LIVE" as const,
      timestamps: { updatedAt: cached.updatedAt },
      milliPoints: cached.milliPoints,
      scale: cached.scale,
      players: cached.players.map((player) => ({
        playerId: player.playerId,
        baseMilliPoints: player.baseMilliPoints,
        teamContributionMilliPoints: player.milliPoints,
        role: player.role,
        baseDisplayed: player.baseMilliPoints / DEV_V1_SCALE,
        contributionDisplayed: player.milliPoints / DEV_V1_SCALE,
      })),
      explanationNote:
        "Personal current-team score uses the latest fantasy team version. Contest entry scores use contest_entries.team_version_id and never silently switch to a newer version.",
      scoreKind: "personal_current_team",
    };
  }
}
