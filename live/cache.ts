import type { RedisClient } from "../redis/client.js";
import { cacheKey, deserializeCacheValue, serializeCacheValue } from "../redis/keys.js";

export type LiveFreshness = "LIVE" | "STALE" | "FINAL" | "DATA_ERROR";

export interface PlayerLiveScoreCache {
  playerId: string;
  matchId: string;
  baseMilliPoints: number;
  updatedAt: string;
}

export interface TeamLiveScoreCache {
  teamId: string;
  matchId: string;
  milliPoints: number;
  scale: number;
  players: Array<{
    playerId: string;
    baseMilliPoints: number;
    milliPoints: number;
    role: "captain" | "vice" | "player";
  }>;
  updatedAt: string;
}

export interface MatchLiveScoreCache {
  matchId: string;
  freshness: LiveFreshness;
  eventCount: number;
  lastEventAt: string | null;
  providerName: string | null;
  playerScores: PlayerLiveScoreCache[];
  updatedAt: string;
}

export interface LeaderboardCacheRow {
  teamId: string;
  accountId: string;
  milliPoints: number;
  rank: number;
}

export interface LeaderboardCache {
  matchId: string;
  contestId: string | null;
  rows: LeaderboardCacheRow[];
  updatedAt: string;
  freshness: LiveFreshness;
}

export class LiveScoreCache {
  constructor(
    private readonly redis: RedisClient,
    private readonly env: string,
  ) {}

  private matchKey(matchId: string): string {
    return cacheKey(this.env, "livescore", matchId);
  }

  private playerKey(matchId: string, playerId: string): string {
    return cacheKey(this.env, "liveplayer", `${matchId}_${playerId}`);
  }

  private teamKey(teamId: string): string {
    return cacheKey(this.env, "liveteam", teamId);
  }

  private boardKey(matchId: string): string {
    return cacheKey(this.env, "liveboard", matchId);
  }

  async writeMatch(score: MatchLiveScoreCache): Promise<void> {
    await this.redis.set(this.matchKey(score.matchId), serializeCacheValue(score));
    for (const player of score.playerScores) {
      await this.redis.set(this.playerKey(score.matchId, player.playerId), serializeCacheValue(player));
    }
  }

  async readMatch(matchId: string): Promise<MatchLiveScoreCache | null> {
    const raw = await this.redis.get(this.matchKey(matchId));
    if (!raw) {
      return null;
    }
    return deserializeCacheValue<MatchLiveScoreCache>(raw);
  }

  async writeTeam(score: TeamLiveScoreCache): Promise<void> {
    await this.redis.set(this.teamKey(score.teamId), serializeCacheValue(score));
  }

  async readTeam(teamId: string): Promise<TeamLiveScoreCache | null> {
    const raw = await this.redis.get(this.teamKey(teamId));
    if (!raw) {
      return null;
    }
    return deserializeCacheValue<TeamLiveScoreCache>(raw);
  }

  async writeLeaderboard(board: LeaderboardCache): Promise<void> {
    await this.redis.set(this.boardKey(board.matchId), serializeCacheValue(board));
  }

  async readLeaderboard(matchId: string): Promise<LeaderboardCache | null> {
    const raw = await this.redis.get(this.boardKey(matchId));
    if (!raw) {
      return null;
    }
    return deserializeCacheValue<LeaderboardCache>(raw);
  }

  async clearMatch(matchId: string, playerIds: readonly string[], teamIds: readonly string[]): Promise<void> {
    await this.redis.del(this.matchKey(matchId));
    await this.redis.del(this.boardKey(matchId));
    for (const playerId of playerIds) {
      await this.redis.del(this.playerKey(matchId, playerId));
    }
    for (const teamId of teamIds) {
      await this.redis.del(this.teamKey(teamId));
    }
  }
}
