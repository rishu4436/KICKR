import { createHash } from "node:crypto";
import { ATTESTATION_DOMAIN, type ResultAttestationClaims } from "./types.js";

/**
 * Deterministic canonical JSON: sorted object keys, fixed UTF-8 JSON encoding.
 * Arrays keep order (entry lists are already ordered by the caller).
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

export function sha256Hex(bytes: Uint8Array | Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Domain-separated hash of attestation claims (excludes signature / status). */
export function hashAttestationClaims(claims: ResultAttestationClaims): string {
  const body = canonicalJson(claims);
  return sha256Hex(`${ATTESTATION_DOMAIN}\n${body}`);
}

/**
 * Hash of the finalized APPROVED score snapshot set for a contest.
 * Sorted by entryId. Domain-separated. Empty set is still deterministic.
 */
export function hashFinalizedSnapshots(
  snapshots: ReadonlyArray<{
    id: string;
    entryId: string;
    matchId: string;
    contestId: string;
    teamVersionId: string;
    rulesetName: string;
    rulesetVersion: number;
    approvedAt: string | null;
    status: string;
    snapshot: unknown;
  }>,
): string {
  const rows = [...snapshots]
    .map((row) => ({
      approvedAt: row.approvedAt,
      contestId: row.contestId,
      entryId: row.entryId,
      id: row.id,
      matchId: row.matchId,
      rulesetName: row.rulesetName,
      rulesetVersion: row.rulesetVersion,
      snapshot: row.snapshot,
      status: row.status,
      teamVersionId: row.teamVersionId,
    }))
    .sort((a, b) => (a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0));
  return sha256Hex(`KICKR_FINALIZED_SNAPSHOTS_V1\n${canonicalJson(rows)}`);
}

export function claimsFromAttestation(row: ResultAttestationClaims): ResultAttestationClaims {
  return {
    version: row.version,
    attestationId: row.attestationId,
    matchId: row.matchId,
    contestId: row.contestId,
    scoringRulesetId: row.scoringRulesetId,
    scoringRulesetVersion: row.scoringRulesetVersion,
    providerSource: row.providerSource,
    finalizedSnapshotHash: row.finalizedSnapshotHash,
    resultHash: row.resultHash,
    issuedAt: row.issuedAt,
    attestorId: row.attestorId,
  };
}
