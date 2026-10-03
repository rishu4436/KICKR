import { Redis } from "ioredis";
import type { RedisClient } from "./client.js";

/**
 * ioredis adapter. Constructed only by the server entrypoint.
 * Unit tests use InMemoryRedis and do not import this module.
 */
export interface ClosableRedis extends RedisClient {
  close(): Promise<void>;
}

export function createIoredisClient(url: string): ClosableRedis {
  const redis = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });

  return {
    async get(key: string): Promise<string | null> {
      return redis.get(key);
    },
    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      if (ttlSeconds !== undefined) {
        await redis.set(key, value, "EX", ttlSeconds);
        return;
      }
      await redis.set(key, value);
    },
    async del(key: string): Promise<void> {
      await redis.del(key);
    },
    async ping(): Promise<boolean> {
      const reply = await redis.ping();
      return reply === "PONG";
    },
    async close(): Promise<void> {
      await redis.quit();
    },
  };
}
