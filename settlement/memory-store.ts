import { newId } from "../shared/ids.js";
import type { SettlementRecord, SettlementResultRow } from "./types.js";

export interface SettlementStore {
  insertSettlement(row: SettlementRecord): Promise<void>;
  updateSettlement(row: SettlementRecord): Promise<void>;
  getSettlement(id: string): Promise<SettlementRecord | null>;
  getLatestForContest(contestId: string): Promise<SettlementRecord | null>;
  listRows(settlementId: string): Promise<SettlementResultRow[]>;
  insertRows(rows: SettlementResultRow[]): Promise<void>;
  updateRow(row: SettlementResultRow): Promise<void>;
  getRowByEntry(settlementId: string, entryId: string): Promise<SettlementResultRow | null>;
  hasConfirmedSettlement(contestId: string): Promise<boolean>;
}

export class InMemorySettlementStore implements SettlementStore {
  readonly settlements = new Map<string, SettlementRecord>();
  readonly rows = new Map<string, SettlementResultRow>();

  async insertSettlement(row: SettlementRecord): Promise<void> {
    const key = `${row.contestId}:${row.settlementVersion}`;
    for (const existing of this.settlements.values()) {
      if (`${existing.contestId}:${existing.settlementVersion}` === key) {
        throw new Error("duplicate settlement version for contest");
      }
    }
    this.settlements.set(row.id, structuredClone(row));
  }

  async updateSettlement(row: SettlementRecord): Promise<void> {
    if (!this.settlements.has(row.id)) {
      throw new Error("settlement not found");
    }
    const prev = this.settlements.get(row.id)!;
    if (
      ["RESULT_APPROVED", "SETTLEMENT_APPROVED", "SETTLEMENT_PREPARED", "SETTLEMENT_SUBMITTED", "SETTLEMENT_CONFIRMED"].includes(
        String(prev.status),
      )
    ) {
      if (
        prev.resultHash !== row.resultHash ||
        prev.settlementVersion !== row.settlementVersion ||
        prev.totalPayoutBaseUnits !== row.totalPayoutBaseUnits ||
        prev.feeBaseUnits !== row.feeBaseUnits
      ) {
        throw new Error("approved settlement economic fields are immutable");
      }
      if (prev.merkleRoot && row.merkleRoot && prev.merkleRoot !== row.merkleRoot) {
        throw new Error("merkle_root is immutable once set");
      }
    }
    this.settlements.set(row.id, structuredClone(row));
  }

  async getSettlement(id: string): Promise<SettlementRecord | null> {
    const row = this.settlements.get(id);
    return row ? structuredClone(row) : null;
  }

  async getLatestForContest(contestId: string): Promise<SettlementRecord | null> {
    const rows = [...this.settlements.values()]
      .filter((row) => row.contestId === contestId)
      .sort((a, b) => b.settlementVersion - a.settlementVersion);
    return rows[0] ? structuredClone(rows[0]) : null;
  }

  async listRows(settlementId: string): Promise<SettlementResultRow[]> {
    return [...this.rows.values()]
      .filter((row) => row.settlementId === settlementId)
      .map((row) => structuredClone(row))
      .sort((a, b) => a.rank - b.rank);
  }

  async insertRows(rows: SettlementResultRow[]): Promise<void> {
    for (const row of rows) {
      this.rows.set(row.id, structuredClone(row));
    }
  }

  async updateRow(row: SettlementResultRow): Promise<void> {
    const prev = this.rows.get(row.id);
    if (!prev) {
      throw new Error("result row not found");
    }
    const settlement = this.settlements.get(prev.settlementId);
    if (
      settlement &&
      ["RESULT_APPROVED", "SETTLEMENT_APPROVED", "SETTLEMENT_PREPARED", "SETTLEMENT_SUBMITTED", "SETTLEMENT_CONFIRMED"].includes(
        String(settlement.status),
      )
    ) {
      if (
        prev.rank !== row.rank ||
        prev.netPayoutBaseUnits !== row.netPayoutBaseUnits ||
        prev.destinationWallet !== row.destinationWallet ||
        prev.finalScoreMilliPoints !== row.finalScoreMilliPoints ||
        prev.teamVersionId !== row.teamVersionId ||
        prev.leafHash !== row.leafHash
      ) {
        throw new Error("approved settlement ranking/payout fields are immutable");
      }
    }
    this.rows.set(row.id, structuredClone(row));
  }

  async getRowByEntry(settlementId: string, entryId: string): Promise<SettlementResultRow | null> {
    const row = [...this.rows.values()].find(
      (item) => item.settlementId === settlementId && item.entryId === entryId,
    );
    return row ? structuredClone(row) : null;
  }

  async hasConfirmedSettlement(contestId: string): Promise<boolean> {
    return [...this.settlements.values()].some(
      (row) => row.contestId === contestId && row.status === "SETTLEMENT_CONFIRMED",
    );
  }
}

export function newSettlementId(): string {
  return newId();
}
