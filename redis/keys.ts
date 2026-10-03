/**
 * Cache key convention: kickr:<env>:<domain>:<id>
 * Redis is never authoritative for financial state, sessions, or audit.
 * Values are JSON documents with an explicit schema version.
 */

export const CACHE_SCHEMA_VERSION = 1;

const SEGMENT = /^[A-Za-z0-9_-]+$/;

export function cacheKey(env: string, domain: string, id: string): string {
  for (const [name, value] of [
    ["env", env],
    ["domain", domain],
    ["id", id],
  ] as const) {
    if (!SEGMENT.test(value)) {
      throw new Error(`Invalid cache key ${name}`);
    }
  }
  return `kickr:${env}:${domain}:${id}`;
}

export interface VersionedCacheValue<T> {
  v: number;
  data: T;
}

export function serializeCacheValue<T>(data: T): string {
  const envelope: VersionedCacheValue<T> = { v: CACHE_SCHEMA_VERSION, data };
  return JSON.stringify(envelope);
}

export function deserializeCacheValue<T>(raw: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Cache value is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Cache value envelope is invalid");
  }
  const envelope = parsed as { v?: unknown; data?: T };
  if (envelope.v !== CACHE_SCHEMA_VERSION) {
    throw new Error(`Unsupported cache schema version: ${String(envelope.v)}`);
  }
  return envelope.data as T;
}
