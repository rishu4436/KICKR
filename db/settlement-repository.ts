/**
 * Postgres SettlementStore. Contests/entries remain the source of identity;
 * this store persists settlement lifecycle for the running API (not process memory).
 */
import type pg from "pg";
import type { SettlementStore } from "../settlement/memory-store.js";
import type { SettlementRecord, SettlementResultRow } from "../settlement/types.js";
import type { ImmutableResultPayload } from "../settlement/result-payload.js";
import { asDate, asString } from "./mappers.js";
import type { Queryable } from "./types.js";

type Row = Record<string, unknown>;

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value === "string" && /^-?\d+$/.test(value)) return Number(value);
  throw new Error("Expected an integer");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function settlementFrom(row: Row): SettlementRecord {
  const payloadRaw = row.payload;
  let payload: ImmutableResultPayload;
  if (payloadRaw && typeof payloadRaw === "object") {
    payload = payloadRaw as ImmutableResultPayload;
  } else if (typeof payloadRaw === "string") {
    payload = JSON.parse(payloadRaw) as ImmutableResultPayload;
  } else {
    throw new Error("settlement payload missing");
  }
  return {
    id: asString(row.id),
    contestId: asString(row.contest_id),
    matchId: asString(row.match_id),
    settlementVersion: asInt(row.settlement_version),
    status: asString(row.status),
    resultHash: asString(row.result_hash),
    merkleRoot: row.merkle_root == null ? null : asString(row.merkle_root),
    settlementHash: row.settlement_hash == null ? null : asString(row.settlement_hash),
    calculationVersion: asInt(row.calculation_version),
    feePolicyId: asString(row.fee_policy_id),
    feePolicyVersion: asInt(row.fee_policy_version),
    feeRateBps: asInt(row.fee_rate_bps),
    payoutPolicyId: asString(row.payout_policy_id),
    payoutPolicyVersion: asInt(row.payout_policy_version),
    payoutPolicyType: asString(row.payout_policy_type),
    payoutConfiguration: asObject(row.payout_configuration),
    rulesetName: asString(row.ruleset_name),
    rulesetVersion: asInt(row.ruleset_version),
    entryFeeBaseUnits: asInt(row.entry_fee_base_units),
    seatCount: asInt(row.seat_count),
    confirmedEntries: asInt(row.confirmed_entries),
    totalPotBaseUnits: asInt(row.total_pot_base_units),
    feeBaseUnits: asInt(row.fee_base_units),
    totalPayoutBaseUnits: asInt(row.total_payout_base_units),
    commitSignature: row.commit_signature == null ? null : asString(row.commit_signature),
    confirmedSlot: row.confirmed_slot == null ? null : asInt(row.confirmed_slot),
    confirmedAt: row.confirmed_at == null ? null : asDate(row.confirmed_at).toISOString(),
    failureReason: row.failure_reason == null ? null : asString(row.failure_reason),
    approvedBy: row.approved_by == null ? null : asString(row.approved_by),
    approvedAt: row.approved_at == null ? null : asDate(row.approved_at).toISOString(),
    createdAt: asDate(row.created_at).toISOString(),
    updatedAt: asDate(row.updated_at).toISOString(),
    payload,
  };
}

function resultRowFrom(row: Row): SettlementResultRow {
  const xiRaw = row.xi;
  const xi = Array.isArray(xiRaw)
    ? xiRaw.map(String)
    : typeof xiRaw === "string"
      ? (JSON.parse(xiRaw) as string[])
      : [];
  return {
    id: asString(row.id),
    settlementId: asString(row.settlement_id),
    contestId: asString(row.contest_id),
    entryId: asString(row.entry_id),
    teamVersionId: asString(row.team_version_id),
    destinationWallet: asString(row.destination_wallet),
    rank: asInt(row.rank),
    baseScoreMilliPoints: asInt(row.base_score_milli_points),
    finalScoreMilliPoints: asInt(row.final_score_milli_points),
    resultStatus: asString(row.result_status),
    xi,
    captainId: asString(row.captain_id),
    viceId: asString(row.vice_id),
    grossAllocationBaseUnits: asInt(row.gross_allocation_base_units),
    feeAllocationBaseUnits: asInt(row.fee_allocation_base_units),
    netPayoutBaseUnits: asInt(row.net_payout_base_units),
    leafHash: asString(row.leaf_hash),
    claimStatus: asString(row.claim_status) as SettlementResultRow["claimStatus"],
    claimSignature: row.claim_signature == null ? null : asString(row.claim_signature),
    claimedAt: row.claimed_at == null ? null : asDate(row.claimed_at).toISOString(),
    createdAt: asDate(row.created_at).toISOString(),
  };
}

const SETTLEMENT_COLUMNS = `
  id, contest_id, match_id, settlement_version, status, result_hash, merkle_root, settlement_hash,
  calculation_version, fee_policy_id, fee_policy_version, fee_rate_bps, payout_policy_id,
  payout_policy_version, payout_policy_type, payout_configuration, ruleset_name, ruleset_version,
  entry_fee_base_units, seat_count, confirmed_entries, total_pot_base_units, fee_base_units,
  total_payout_base_units, commit_signature, confirmed_slot, confirmed_at, failure_reason,
  approved_by, approved_at, created_at, updated_at, payload
`;

const ROW_COLUMNS = `
  id, settlement_id, contest_id, entry_id, team_version_id, destination_wallet, rank,
  base_score_milli_points, final_score_milli_points, result_status, xi, captain_id, vice_id,
  gross_allocation_base_units, fee_allocation_base_units, net_payout_base_units, leaf_hash,
  claim_status, claim_signature, claimed_at, created_at
`;

export function createPgSettlementStore(db: Queryable): SettlementStore {
  return {
    async insertSettlement(row) {
      const approvedBy = row.approvedBy && isUuid(row.approvedBy) ? row.approvedBy : null;
      await db.query(
        `INSERT INTO contest_settlements (
          id, contest_id, match_id, settlement_version, status, result_hash, merkle_root, settlement_hash,
          calculation_version, fee_policy_id, fee_policy_version, fee_rate_bps, payout_policy_id,
          payout_policy_version, payout_policy_type, payout_configuration, ruleset_name, ruleset_version,
          entry_fee_base_units, seat_count, confirmed_entries, total_pot_base_units, fee_base_units,
          total_payout_base_units, commit_signature, confirmed_slot, confirmed_at, failure_reason,
          approved_by, approved_at, created_at, updated_at, payload
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,
          $9,$10,$11,$12,$13,
          $14,$15,$16::jsonb,$17,$18,
          $19,$20,$21,$22,$23,
          $24,$25,$26,$27,$28,
          $29,$30,$31,$32,$33::jsonb
        )`,
        [
          row.id,
          row.contestId,
          row.matchId,
          row.settlementVersion,
          row.status,
          row.resultHash,
          row.merkleRoot,
          row.settlementHash,
          row.calculationVersion,
          row.feePolicyId,
          row.feePolicyVersion,
          row.feeRateBps,
          row.payoutPolicyId,
          row.payoutPolicyVersion,
          row.payoutPolicyType,
          JSON.stringify(row.payoutConfiguration),
          row.rulesetName,
          row.rulesetVersion,
          row.entryFeeBaseUnits,
          row.seatCount,
          row.confirmedEntries,
          row.totalPotBaseUnits,
          row.feeBaseUnits,
          row.totalPayoutBaseUnits,
          row.commitSignature,
          row.confirmedSlot,
          row.confirmedAt,
          row.failureReason,
          approvedBy,
          row.approvedAt,
          row.createdAt,
          row.updatedAt,
          JSON.stringify(row.payload),
        ],
      );
    },

    async updateSettlement(row) {
      const approvedBy = row.approvedBy && isUuid(row.approvedBy) ? row.approvedBy : null;
      const result = await db.query(
        `UPDATE contest_settlements SET
          status = $2,
          merkle_root = $3,
          settlement_hash = $4,
          commit_signature = $5,
          confirmed_slot = $6,
          confirmed_at = $7,
          failure_reason = $8,
          approved_by = $9,
          approved_at = $10,
          updated_at = $11,
          payload = COALESCE(payload, $12::jsonb)
         WHERE id = $1`,
        [
          row.id,
          row.status,
          row.merkleRoot,
          row.settlementHash,
          row.commitSignature,
          row.confirmedSlot,
          row.confirmedAt,
          row.failureReason,
          approvedBy,
          row.approvedAt,
          row.updatedAt,
          JSON.stringify(row.payload),
        ],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error("settlement not found");
      }
    },

    async getSettlement(id) {
      const result = await db.query<Row>(
        `SELECT ${SETTLEMENT_COLUMNS} FROM contest_settlements WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? settlementFrom(row) : null;
    },

    async getLatestForContest(contestId) {
      const result = await db.query<Row>(
        `SELECT ${SETTLEMENT_COLUMNS} FROM contest_settlements
         WHERE contest_id = $1
         ORDER BY settlement_version DESC
         LIMIT 1`,
        [contestId],
      );
      const row = result.rows[0];
      return row ? settlementFrom(row) : null;
    },

    async listRows(settlementId) {
      const result = await db.query<Row>(
        `SELECT ${ROW_COLUMNS} FROM settlement_result_rows
         WHERE settlement_id = $1
         ORDER BY rank ASC`,
        [settlementId],
      );
      return result.rows.map(resultRowFrom);
    },

    async insertRows(rows) {
      for (const row of rows) {
        await db.query(
          `INSERT INTO settlement_result_rows (
            id, settlement_id, contest_id, entry_id, team_version_id, destination_wallet, rank,
            base_score_milli_points, final_score_milli_points, result_status, xi, captain_id, vice_id,
            gross_allocation_base_units, fee_allocation_base_units, net_payout_base_units, leaf_hash,
            claim_status, claim_signature, claimed_at, created_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,
            $8,$9,$10,$11::jsonb,$12,$13,
            $14,$15,$16,$17,
            $18,$19,$20,$21
          )`,
          [
            row.id,
            row.settlementId,
            row.contestId,
            row.entryId,
            row.teamVersionId,
            row.destinationWallet,
            row.rank,
            row.baseScoreMilliPoints,
            row.finalScoreMilliPoints,
            row.resultStatus,
            JSON.stringify(row.xi),
            row.captainId,
            row.viceId,
            row.grossAllocationBaseUnits,
            row.feeAllocationBaseUnits,
            row.netPayoutBaseUnits,
            row.leafHash,
            row.claimStatus,
            row.claimSignature,
            row.claimedAt,
            row.createdAt,
          ],
        );
      }
    },

    async updateRow(row) {
      const result = await db.query(
        `UPDATE settlement_result_rows SET
          claim_status = $2,
          claim_signature = $3,
          claimed_at = $4
         WHERE id = $1`,
        [row.id, row.claimStatus, row.claimSignature, row.claimedAt],
      );
      if ((result.rowCount ?? 0) !== 1) {
        throw new Error("result row not found");
      }
    },

    async getRowByEntry(settlementId, entryId) {
      const result = await db.query<Row>(
        `SELECT ${ROW_COLUMNS} FROM settlement_result_rows
         WHERE settlement_id = $1 AND entry_id = $2`,
        [settlementId, entryId],
      );
      const row = result.rows[0];
      return row ? resultRowFrom(row) : null;
    },

    async hasConfirmedSettlement(contestId) {
      const result = await db.query(
        `SELECT 1 FROM contest_settlements
         WHERE contest_id = $1 AND status = 'SETTLEMENT_CONFIRMED'
         LIMIT 1`,
        [contestId],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
}

export function createPgSettlementStoreFromPool(pool: pg.Pool): SettlementStore {
  return createPgSettlementStore(pool);
}
