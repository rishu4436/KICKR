/**
 * Postgres AttestationStore. Additive persistence for Phase 9 result attestations.
 */
import type { AttestationStore, ResultAttestation, AttestationVerificationStatus } from "../attestation/types.js";
import { ATTESTATION_VERSION } from "../attestation/types.js";
import { AppError } from "../shared/errors.js";
import { asDate, asString } from "./mappers.js";
import type { Queryable } from "./types.js";

type Row = Record<string, unknown>;

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error("Expected an integer");
}

function mapRow(row: Row): ResultAttestation {
  return {
    version: ATTESTATION_VERSION,
    attestationId: asString(row.attestation_id),
    matchId: asString(row.match_id),
    contestId: asString(row.contest_id),
    scoringRulesetId: asString(row.scoring_ruleset_id),
    scoringRulesetVersion: asInt(row.scoring_ruleset_version),
    providerSource: asString(row.provider_source),
    finalizedSnapshotHash: asString(row.finalized_snapshot_hash),
    resultHash: asString(row.result_hash),
    issuedAt: asDate(row.issued_at).toISOString(),
    attestorId: asString(row.attestor_id),
    signature: asString(row.signature),
    verificationStatus: asString(row.verification_status) as AttestationVerificationStatus,
    boundSettlementId: row.bound_settlement_id == null ? null : asString(row.bound_settlement_id),
    createdAt: asDate(row.created_at).toISOString(),
    updatedAt: asDate(row.updated_at).toISOString(),
  };
}

function payloadOf(row: ResultAttestation): Record<string, unknown> {
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
    signature: row.signature,
    verificationStatus: row.verificationStatus,
    boundSettlementId: row.boundSettlementId,
  };
}

export function createPgAttestationStore(db: Queryable): AttestationStore {
  return {
    async insert(row: ResultAttestation): Promise<void> {
      try {
        await db.query(
          `INSERT INTO result_attestations (
             attestation_id, match_id, contest_id, scoring_ruleset_id, scoring_ruleset_version,
             provider_source, finalized_snapshot_hash, result_hash, issued_at, attestor_id,
             signature, verification_status, bound_settlement_id, payload, created_at, updated_at
           ) VALUES (
             $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16
           )`,
          [
            row.attestationId,
            row.matchId,
            row.contestId,
            row.scoringRulesetId,
            row.scoringRulesetVersion,
            row.providerSource,
            row.finalizedSnapshotHash,
            row.resultHash,
            row.issuedAt,
            row.attestorId,
            row.signature,
            row.verificationStatus,
            row.boundSettlementId,
            JSON.stringify(payloadOf(row)),
            row.createdAt,
            row.updatedAt,
          ],
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/duplicate|unique/i.test(message)) {
          throw new AppError("ATTESTATION_DUPLICATE", 409, "Attestation id or contest/result already exists");
        }
        throw error;
      }
    },

    async update(row: ResultAttestation): Promise<void> {
      const result = await db.query(
        `UPDATE result_attestations SET
           verification_status = $2,
           bound_settlement_id = $3,
           payload = $4::jsonb,
           updated_at = $5
         WHERE attestation_id = $1`,
        [
          row.attestationId,
          row.verificationStatus,
          row.boundSettlementId,
          JSON.stringify(payloadOf(row)),
          row.updatedAt,
        ],
      );
      if ((result.rowCount ?? 0) === 0) {
        throw new AppError("NOT_FOUND", 404, "Attestation not found");
      }
    },

    async getById(attestationId: string): Promise<ResultAttestation | null> {
      const result = await db.query<Row>(
        `SELECT * FROM result_attestations WHERE attestation_id = $1`,
        [attestationId],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async findForContestResult(contestId: string, resultHash: string): Promise<ResultAttestation | null> {
      const result = await db.query<Row>(
        `SELECT * FROM result_attestations WHERE contest_id = $1 AND result_hash = $2`,
        [contestId, resultHash],
      );
      const row = result.rows[0];
      return row ? mapRow(row) : null;
    },

    async listForContest(contestId: string): Promise<ResultAttestation[]> {
      const result = await db.query<Row>(
        `SELECT * FROM result_attestations WHERE contest_id = $1 ORDER BY issued_at ASC, attestation_id ASC`,
        [contestId],
      );
      return result.rows.map((row) => mapRow(row));
    },
  };
}
