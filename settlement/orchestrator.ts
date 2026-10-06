import { AppError } from "../shared/errors.js";
import type { ContestStore } from "../contests/store.js";
import type { SnapshotStore } from "../live/snapshot.js";
import { DEV_V1_RULESET } from "../domain/scoring/dev-v1.js";
import type { SettlementService } from "./service.js";
import { loadApprovedSnapshotsForContest, snapshotsToRankedEntries } from "./from-snapshots.js";
import type { FrozenFeePolicy, FrozenPayoutPolicy } from "./payouts.js";
import type { SettlementRecord } from "./types.js";
import { rejectFreeMoneyPath } from "../contests/kind.js";

/**
 * Wires Phase 5.1 APPROVED snapshots + frozen contest rules into Phase 6 calculation.
 * No synthetic winners. No mutable template values.
 */
export class SettlementOrchestrator {
  constructor(
    private readonly settlements: SettlementService,
    private readonly contests: ContestStore,
    private readonly snapshots: SnapshotStore,
  ) {}

  async calculateFromApprovedSnapshots(input: {
    contestId: string;
    matchSettlementGate: "FINAL" | "DATA_FINALIZING";
    actorId: string;
    nowIso: string;
  }): Promise<SettlementRecord> {
    const contest = await this.contests.getContest(input.contestId);
    if (!contest) {
      throw new AppError("NOT_FOUND", 404, "Contest not found");
    }
    rejectFreeMoneyPath(contest, "settlement-calculate");
    const entries = (await this.contests.listEntries(contest.id)).filter(
      (entry) => entry.status === "CONFIRMED",
    );
    if (entries.length === 0) {
      throw new AppError("NO_CONFIRMED_ENTRIES", 409, "Contest has no confirmed entries to settle");
    }
    const approved = await loadApprovedSnapshotsForContest(
      this.snapshots,
      contest.id,
      entries.map((entry) => entry.id),
    );
    for (const snap of approved) {
      if (snap.matchId !== contest.matchId) {
        throw new AppError("SNAPSHOT_MATCH_MISMATCH", 409, "Snapshot match_id does not match contest");
      }
      if (snap.contestId !== contest.id) {
        throw new AppError("SNAPSHOT_CONTEST_MISMATCH", 409, "Snapshot contest_id mismatch");
      }
      const entry = entries.find((row) => row.id === snap.entryId);
      if (!entry) {
        throw new AppError("SNAPSHOT_ENTRY_MISMATCH", 409, "Snapshot entry is not a confirmed entrant");
      }
      if (entry.teamVersionId !== snap.teamVersionId) {
        throw new AppError(
          "TEAM_VERSION_MISMATCH",
          409,
          "Settlement must use contest_entries.team_version_id exactly; snapshot disagrees",
        );
      }
    }

    const rules = contest.rulesSnapshot;
    const feePolicy: FrozenFeePolicy & { label?: string } = {
      id: rules.feePolicyId,
      version: rules.feePolicyVersion,
      rateBps: rules.feeRateBps,
      label: typeof rules.feeConfiguration.label === "string" ? rules.feeConfiguration.label : "DEV",
    };
    const payoutPolicy: FrozenPayoutPolicy = {
      id: rules.payoutPolicyId,
      version: rules.payoutPolicyVersion,
      policyType: rules.payoutPolicyType,
      configuration: rules.payoutConfiguration as FrozenPayoutPolicy["configuration"],
    };

    const destinationByEntryId = new Map(entries.map((entry) => [entry.id, entry.wallet]));
    const ranked = snapshotsToRankedEntries(approved, destinationByEntryId);

    return this.settlements.calculate({
      contestId: contest.id,
      matchId: contest.matchId,
      matchSettlementGate: input.matchSettlementGate,
      entryFeeBaseUnits: rules.entryFeeBaseUnits,
      seatCount: rules.capacity,
      contestRules: rules,
      rulesetName: rules.scoringRulesetName || DEV_V1_RULESET.name,
      rulesetVersion: rules.scoringRulesetVersion || DEV_V1_RULESET.version,
      feePolicy,
      payoutPolicy,
      entries: ranked,
      actorId: input.actorId,
      nowIso: input.nowIso,
    });
  }

  async prepareIfReady(settlementId: string, nowIso: string): Promise<SettlementRecord> {
    const settlement = await this.settlements.getById(settlementId);
    if (!settlement) {
      throw new AppError("NOT_FOUND", 404, "Settlement not found");
    }
    const prepareContest = await this.contests.getContest(settlement.contestId);
    if (prepareContest) {
      rejectFreeMoneyPath(prepareContest, "settlement-prepare");
    }
    if (
      settlement.status !== "SETTLEMENT_APPROVED" &&
      settlement.status !== "SETTLEMENT_PREPARED" &&
      settlement.status !== "SETTLEMENT_FAILED"
    ) {
      throw new AppError("NOT_APPROVED", 409, "Settlement must be economically approved before prepare");
    }
    // Re-check snapshots still APPROVED (immutability); refuse if any entry lost approval.
    const entries = (await this.contests.listEntries(settlement.contestId)).filter(
      (entry) => entry.status === "CONFIRMED",
    );
    await loadApprovedSnapshotsForContest(
      this.snapshots,
      settlement.contestId,
      entries.map((entry) => entry.id),
    );
    return this.settlements.prepare(settlementId, nowIso);
  }
}
