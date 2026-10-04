import type { RedisClient } from "../redis/client.js";
import { cacheKey, deserializeCacheValue, serializeCacheValue } from "../redis/keys.js";
import type { DiscoveryView } from "./types.js";

/**
 * Hot discovery cache only. Postgres remains authoritative.
 * Payments, confirmed entries, escrow, settlement, and winners are never read from here.
 * Write order is database, then durable audit/outbox, then this cache.
 */
export class ContestDiscoveryCache {
  constructor(
    private readonly redis: RedisClient,
    private readonly env: string,
  ) {}

  async readMatch(matchId: string): Promise<DiscoveryView[] | null> {
    try {
      const alive = await this.redis.ping();
      if (!alive) {
        return null;
      }
      const raw = await this.redis.get(cacheKey(this.env, "contestmatch", matchId));
      if (!raw) {
        return null;
      }
      return deserializeCacheValue<DiscoveryView[]>(raw);
    } catch {
      return null;
    }
  }

  async writeMatch(matchId: string, rows: readonly DiscoveryView[]): Promise<void> {
    try {
      await this.redis.set(cacheKey(this.env, "contestmatch", matchId), serializeCacheValue(rows), 30);
    } catch {
      // Discovery degrades to Postgres. Cache failure is not a failed join.
    }
  }

  async invalidateMatch(matchId: string): Promise<void> {
    try {
      await this.redis.del(cacheKey(this.env, "contestmatch", matchId));
    } catch {
      // Next read falls through to Postgres when the cache is unreachable.
    }
  }
}
