import { transition } from "../domain/state-machine.js";
import { newId } from "../shared/ids.js";
import { AppError } from "../shared/errors.js";
import { computeSettlementHash } from "./hash.js";
import { buildMerkleTree, payoutLeaf, toHex32 } from "./merkle.js";
import { computePayouts, type FrozenFeePolicy, type FrozenPayoutPolicy, type RankedEntryInput } from "./payouts.js";
import { buildResultPayload, hashResultPayload } from "./result-payload.js";
import type { SettlementStore } from "./memory-store.js";
import type { SettlementRecord, SettlementResultRow } from "./types.js";

export interface CalculateSettlementInput {
  contestId: string;
  matchId: string;
  matchSettlementGate: "FINAL" | "DATA_FINALIZING";
  entryFeeBaseUnits: number;
  seatCount: number;
  contestRules: unknown;
  rulesetName: string;
  rulesetVersion: number;
  feePolicy: FrozenFeePolicy & { label?: string };
  payoutPolicy: FrozenPayoutPolicy;
  entries: RankedEntryInput[];
  actorId: string;
  nowIso: string;
  /** When recalculating after rejection, bump calculation version. */
  priorSettlementId?: string;
}

export class SettlementService {
  constructor(private readonly store: SettlementStore) {}

  async calculate(input: CalculateSettlementInput): Promise<SettlementRecord> {
    if (input.matchSettlementGate !== "FINAL" && input.matchSettlementGate !== "DATA_FINALIZING") {
      throw new AppError("MATCH_NOT_READY", 409, "Match must reach DATA_FINALIZING/FINAL before calculation");
    }
    if (await this.store.hasConfirmedSettlement(input.contestId)) {
      throw new AppError("SETTLEMENT_CONFIRMED", 409, "Confirmed settlement cannot be recalculated");
    }

    let settlementVersion = 1;
    let calculationVersion = 1;
    let fromStatus: string = input.matchSettlementGate === "DATA_FINALIZING" ? "DATA_FINALIZING" : "FINAL";
    if (input.matchSettlementGate === "DATA_FINALIZING") {
      transition("SETTLEMENT", "DATA_FINALIZING", "FINAL");
      fromStatus = "FINAL";
    }
    const prior = await this.store.getLatestForContest(input.contestId);
    if (prior) {
      if (["RESULT_APPROVED", "SETTLEMENT_APPROVED", "SETTLEMENT_PREPARED", "SETTLEMENT_SUBMITTED", "SETTLEMENT_CONFIRMED"].includes(String(prior.status))) {
        throw new AppError("RESULT_IMMUTABLE", 409, "Approved results cannot be silently mutated; reject first or use a new contest");
      }
      if (prior.status === "RESULT_REJECTED") {
        settlementVersion = prior.settlementVersion + 1;
        calculationVersion = prior.calculationVersion + 1;
        transition("SETTLEMENT", "RESULT_REJECTED", "RESULT_CALCULATED");
      } else if (prior.status === "RESULT_CALCULATED") {
        settlementVersion = prior.settlementVersion + 1;
        calculationVersion = prior.calculationVersion + 1;
      }
    } else {
      transition("SETTLEMENT", fromStatus, "RESULT_CALCULATED");
    }

    const computation = computePayouts({
      entries: input.entries,
      entryFeeBaseUnits: input.entryFeeBaseUnits,
      feePolicy: input.feePolicy,
      payoutPolicy: input.payoutPolicy,
    });
    const payload = buildResultPayload({
      contestId: input.contestId,
      matchId: input.matchId,
      settlementVersion,
      calculationVersion,
      rulesetName: input.rulesetName,
      rulesetVersion: input.rulesetVersion,
      contestRules: input.contestRules,
      entryFeeBaseUnits: input.entryFeeBaseUnits,
      seatCount: input.seatCount,
      feePolicy: input.feePolicy,
      payoutPolicy: input.payoutPolicy,
      computation,
    });
    const resultHash = hashResultPayload(payload);
    const settlement: SettlementRecord = {
      id: newId(),
      contestId: input.contestId,
      matchId: input.matchId,
      settlementVersion,
      status: "RESULT_CALCULATED",
      resultHash,
      merkleRoot: null,
      settlementHash: null,
      calculationVersion,
      feePolicyId: input.feePolicy.id,
      feePolicyVersion: input.feePolicy.version,
      feeRateBps: input.feePolicy.rateBps,
      payoutPolicyId: input.payoutPolicy.id,
      payoutPolicyVersion: input.payoutPolicy.version,
      payoutPolicyType: input.payoutPolicy.policyType,
      payoutConfiguration: input.payoutPolicy.configuration,
      rulesetName: input.rulesetName,
      rulesetVersion: input.rulesetVersion,
      entryFeeBaseUnits: input.entryFeeBaseUnits,
      seatCount: input.seatCount,
      confirmedEntries: computation.rows.length,
      totalPotBaseUnits: computation.totalPotBaseUnits,
      feeBaseUnits: computation.feeBaseUnits,
      totalPayoutBaseUnits: computation.totalPayoutBaseUnits,
      commitSignature: null,
      confirmedSlot: null,
      confirmedAt: null,
      failureReason: null,
      approvedBy: null,
      approvedAt: null,
      createdAt: input.nowIso,
      updatedAt: input.nowIso,
      payload,
    };
    await this.store.insertSettlement(settlement);
    const rows: SettlementResultRow[] = computation.rows.map((row) => ({
      id: newId(),
      settlementId: settlement.id,
      contestId: input.contestId,
      entryId: row.entryId,
      teamVersionId: row.teamVersionId,
      destinationWallet: row.destinationWallet,
      rank: row.rank,
      baseScoreMilliPoints: row.baseScoreMilliPoints,
      finalScoreMilliPoints: row.finalScoreMilliPoints,
      resultStatus: row.resultStatus,
      xi: row.xi,
      captainId: row.captainId,
      viceId: row.viceId,
      grossAllocationBaseUnits: row.grossAllocationBaseUnits,
      feeAllocationBaseUnits: row.feeAllocationBaseUnits,
      netPayoutBaseUnits: row.netPayoutBaseUnits,
      leafHash: toHex32(payoutLeaf(row.entryId, row.netPayoutBaseUnits, row.destinationWallet)),
      claimStatus: "UNCLAIMED",
      claimSignature: null,
      claimedAt: null,
      createdAt: input.nowIso,
    }));
    await this.store.insertRows(rows);
    return settlement;
  }

  async review(settlementId: string, actorId: string, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.require(settlementId);
    transition("SETTLEMENT", String(settlement.status), "RESULT_REVIEWED");
    settlement.status = "RESULT_REVIEWED";
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    void actorId;
    return settlement;
  }

  async reject(settlementId: string, actorId: string, reason: string, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.require(settlementId);
    transition("SETTLEMENT", String(settlement.status), "RESULT_REJECTED");
    settlement.status = "RESULT_REJECTED";
    settlement.failureReason = reason;
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    void actorId;
    return settlement;
  }

  async approve(settlementId: string, actorId: string, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.require(settlementId);
    transition("SETTLEMENT", String(settlement.status), "RESULT_APPROVED");
    settlement.status = "RESULT_APPROVED";
    settlement.approvedBy = actorId;
    settlement.approvedAt = nowIso;
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    transition("SETTLEMENT", "RESULT_APPROVED", "SETTLEMENT_APPROVED");
    settlement.status = "SETTLEMENT_APPROVED";
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    return settlement;
  }

  async prepare(settlementId: string, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.require(settlementId);
    if (String(settlement.status) === "SETTLEMENT_PREPARED" && settlement.merkleRoot) {
      return settlement;
    }
    if (String(settlement.status) === "SETTLEMENT_FAILED" && settlement.merkleRoot) {
      // Retry uses the same commitment; do not create a second settlement.
      return settlement;
    }
    transition("SETTLEMENT", String(settlement.status), "SETTLEMENT_PREPARED");
    const rows = await this.store.listRows(settlementId);
    // Only positive payouts are claimable leaves; zero-payout entries are omitted from merkle.
    const claimable = rows.filter((row) => row.netPayoutBaseUnits > 0);
    const leaves = claimable.map((row) => payoutLeaf(row.entryId, row.netPayoutBaseUnits, row.destinationWallet));
    const tree = buildMerkleTree(leaves);
    settlement.merkleRoot = toHex32(tree.root);
    settlement.settlementHash = computeSettlementHash({
      resultHash: settlement.resultHash,
      merkleRoot: settlement.merkleRoot,
      settlementVersion: settlement.settlementVersion,
      totalPayoutBaseUnits: settlement.totalPayoutBaseUnits,
      feeBaseUnits: settlement.feeBaseUnits,
    });
    settlement.status = "SETTLEMENT_PREPARED";
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    return settlement;
  }

  async markSubmitted(settlementId: string, signature: string, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.require(settlementId);
    if (settlement.status === "SETTLEMENT_CONFIRMED") {
      return settlement;
    }
    if (settlement.status === "SETTLEMENT_SUBMITTED" && settlement.commitSignature === signature) {
      return settlement;
    }
    if (settlement.status === "SETTLEMENT_FAILED") {
      transition("SETTLEMENT", "SETTLEMENT_FAILED", "SETTLEMENT_SUBMITTED");
    } else {
      transition("SETTLEMENT", String(settlement.status), "SETTLEMENT_SUBMITTED");
    }
    settlement.status = "SETTLEMENT_SUBMITTED";
    settlement.commitSignature = signature;
    settlement.failureReason = null;
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    return settlement;
  }

  async markConfirmed(settlementId: string, slot: number, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.require(settlementId);
    if (settlement.status === "SETTLEMENT_CONFIRMED") {
      return settlement;
    }
    transition("SETTLEMENT", String(settlement.status), "SETTLEMENT_CONFIRMED");
    settlement.status = "SETTLEMENT_CONFIRMED";
    settlement.confirmedSlot = slot;
    settlement.confirmedAt = nowIso;
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    return settlement;
  }

  async markFailed(settlementId: string, reason: string, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.require(settlementId);
    if (settlement.status === "SETTLEMENT_CONFIRMED") {
      throw new AppError("ALREADY_CONFIRMED", 409, "Cannot fail a confirmed settlement");
    }
    // Reconcile-before-fail: caller must have checked chain first.
    transition("SETTLEMENT", String(settlement.status), "SETTLEMENT_FAILED");
    settlement.status = "SETTLEMENT_FAILED";
    settlement.failureReason = reason;
    settlement.updatedAt = nowIso;
    await this.store.updateSettlement(settlement);
    return settlement;
  }

  async markClaimed(settlementId: string, entryId: string, signature: string, nowIso: string): Promise<SettlementResultRow> {
    const row = await this.store.getRowByEntry(settlementId, entryId);
    if (!row) {
      throw new AppError("ENTRY_NOT_FOUND", 404, "Settlement entry not found");
    }
    if (row.claimStatus === "CLAIMED" && row.claimSignature === signature) {
      return row;
    }
    if (row.claimStatus === "CLAIMED") {
      throw new AppError("ALREADY_CLAIMED", 409, "Payout already claimed");
    }
    row.claimStatus = "CLAIMED";
    row.claimSignature = signature;
    row.claimedAt = nowIso;
    await this.store.updateRow(row);
    return row;
  }

  async getById(settlementId: string): Promise<SettlementRecord | null> {
    return this.store.getSettlement(settlementId);
  }

  async getStatus(contestId: string): Promise<SettlementRecord | null> {
    return this.store.getLatestForContest(contestId);
  }

  async getLeaderboard(settlementId: string): Promise<SettlementResultRow[]> {
    return this.store.listRows(settlementId);
  }

  async claimProof(settlementId: string, entryId: string): Promise<{
    settlement: SettlementRecord;
    row: SettlementResultRow;
    proof: string[];
    leafIndex: number;
  }> {
    const settlement = await this.require(settlementId);
    if (!settlement.merkleRoot) {
      throw new AppError("NOT_PREPARED", 409, "Settlement merkle root missing");
    }
    const rows = await this.store.listRows(settlementId);
    const claimable = rows.filter((row) => row.netPayoutBaseUnits > 0);
    const leafIndex = claimable.findIndex((row) => row.entryId === entryId);
    if (leafIndex < 0) {
      throw new AppError("NO_PAYOUT", 404, "Entry has no claimable payout");
    }
    const leaves = claimable.map((row) => payoutLeaf(row.entryId, row.netPayoutBaseUnits, row.destinationWallet));
    const tree = buildMerkleTree(leaves);
    const row = claimable[leafIndex]!;
    return {
      settlement,
      row,
      proof: tree.proofs[leafIndex]!.map(toHex32),
      leafIndex,
    };
  }

  private async require(id: string): Promise<SettlementRecord> {
    const settlement = await this.store.getSettlement(id);
    if (!settlement) {
      throw new AppError("NOT_FOUND", 404, "Settlement not found");
    }
    return settlement;
  }
}
