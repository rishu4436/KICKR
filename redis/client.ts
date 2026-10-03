/**
 * Cache client abstraction. Financial state must not be read from here
 * as a source of truth. Health checks accept any implementation, including a fake.
 */

export interface RedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<void>;
  ping(): Promise<boolean>;
}

export interface RedisHealth {
  ok: boolean;
  latencyMs: number;
}

export async function checkRedisHealth(client: RedisClient): Promise<RedisHealth> {
  const start = Date.now();
  try {
    const ok = await client.ping();
    return { ok, latencyMs: Date.now() - start };
  } catch {
    return { ok: false, latencyMs: Date.now() - start };
  }
}

/** In-memory fake. Does not open a socket. */
export class InMemoryRedis implements RedisClient {
  private readonly values = new Map<string, { value: string; expiresAt: number | null }>();

  async get(key: string): Promise<string | null> {
    const row = this.values.get(key);
    if (!row) {
      return null;
    }
    if (row.expiresAt !== null && row.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return row.value;
  }

  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    const expiresAt =
      ttlSeconds === undefined ? null : Date.now() + ttlSeconds * 1000;
    this.values.set(key, { value, expiresAt });
  }

  async del(key: string): Promise<void> {
    this.values.delete(key);
  }

  async ping(): Promise<boolean> {
    return true;
  }
}
