import type { RequestContext } from "../auth/types.js";
import type { AuditStore } from "../audit/types.js";
import type { FootballService } from "../football/service.js";
import type { RedisClient } from "../redis/client.js";
import type { ProviderIdMap } from "../sports/id-map.js";
import { LiveScoreCache } from "./cache.js";
import { LiveScoreHub } from "./hub.js";
import { LiveMetrics } from "./metrics.js";
import { LiveScoringPipeline, type ContestScoringSource, type LivePipelineStore } from "./pipeline.js";
import { DEV_V1_RULESET, DEV_V1_SCALE } from "../domain/scoring/dev-v1.js";
import { derivePitchStates, type LineupSeed } from "./lineup.js";
import {
  computeScoreSnapshotId,
  eventLogFingerprint,
  isScoreSnapshotFresh,
} from "./score-snapshot.js";

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
    );
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
          scale: DEV_V1_SCALE,
          ruleset: { name: DEV_V1_RULESET.name, status: DEV_V1_RULESET.status },
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
      scale: DEV_V1_SCALE,
      ruleset: { name: DEV_V1_RULESET.name, status: DEV_V1_RULESET.status },
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
