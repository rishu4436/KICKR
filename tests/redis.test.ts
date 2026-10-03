import { describe, expect, it } from "vitest";
import { checkRedisHealth, InMemoryRedis, type RedisClient } from "../redis/client.js";
import { cacheKey, deserializeCacheValue, serializeCacheValue } from "../redis/keys.js";

describe("redis cache abstraction", () => {
  it("round-trips a versioned namespaced value on a fake client", async () => {
    const redis = new InMemoryRedis();
    const key = cacheKey("test", "health", "probe-1");
    expect(key).toBe("kickr:test:health:probe-1");
    await redis.set(key, serializeCacheValue({ ok: true }), 30);
    const raw = await redis.get(key);
    expect(raw).toBeTruthy();
    expect(deserializeCacheValue<{ ok: boolean }>(raw ?? "")).toEqual({ ok: true });
    const health = await checkRedisHealth(redis);
    expect(health.ok).toBe(true);
  });

  it("reports an unhealthy fake without a live server", async () => {
    const failing: RedisClient = {
      async get() {
        return null;
      },
      async set() {
        return undefined;
      },
      async del() {
        return undefined;
      },
      async ping() {
        throw new Error("redis down");
      },
    };
    const health = await checkRedisHealth(failing);
    expect(health.ok).toBe(false);
  });

  it("rejects a cache document from another schema version", () => {
    expect(() => deserializeCacheValue('{"v":2,"data":{}}')).toThrow(/version/i);
    expect(() => cacheKey("prod", "bad:domain", "1")).toThrow(/domain/);
  });
});
