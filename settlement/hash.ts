import { createHash } from "node:crypto";

/**
 * Canonical deterministic serialization for result_hash.
 * Same DB-equivalent payload → same SHA-256 hex.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeys(record[key]);
    }
    return out;
  }
  return value;
}

export function sha256HexBytes(bytes: Uint8Array | Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function computeResultHash(payload: unknown): string {
  return sha256HexBytes(canonicalJson(payload));
}

export function computeSettlementHash(input: {
  resultHash: string;
  merkleRoot: string;
  settlementVersion: number;
  totalPayoutBaseUnits: number;
  feeBaseUnits: number;
}): string {
  return computeResultHash({
    kind: "KICKR_SETTLEMENT_V1",
    ...input,
  });
}
