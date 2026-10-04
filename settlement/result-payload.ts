import { computeResultHash } from "./hash.js";
import type { PayoutComputation, PayoutRow } from "./payouts.js";

export interface ImmutableResultPayload {
  kind: "KICKR_RESULT_V1";
  contestId: string;
  matchId: string;
  settlementVersion: number;
  calculationVersion: number;
  ruleset: { name: string; version: number };
  contestRules: unknown;
  entryFeeBaseUnits: number;
  seatCount: number;
  confirmedEntries: number;
  feePolicy: {
    id: string;
    version: number;
    rateBps: number;
    label: string;
  };
  payoutPolicy: {
    id: string;
    version: number;
    policyType: string;
    configuration: unknown;
  };
  tiePolicy: string;
  entries: Array<{
    entryId: string;
    teamVersionId: string;
    xi: string[];
    captainId: string;
    viceId: string;
    baseScoreMilliPoints: number;
    finalScoreMilliPoints: number;
    rank: number;
    resultStatus: string;
    payoutAmountBaseUnits: number;
    destinationWallet: string;
    grossAllocationBaseUnits: number;
    feeAllocationBaseUnits: number;
  }>;
  totals: {
    totalPotBaseUnits: number;
    feeBaseUnits: number;
    totalPayoutBaseUnits: number;
  };
}

export function buildResultPayload(input: {
  contestId: string;
  matchId: string;
  settlementVersion: number;
  calculationVersion: number;
  rulesetName: string;
  rulesetVersion: number;
  contestRules: unknown;
  entryFeeBaseUnits: number;
  seatCount: number;
  feePolicy: { id: string; version: number; rateBps: number; label?: string };
  payoutPolicy: { id: string; version: number; policyType: string; configuration: unknown };
  computation: PayoutComputation;
}): ImmutableResultPayload {
  return {
    kind: "KICKR_RESULT_V1",
    contestId: input.contestId,
    matchId: input.matchId,
    settlementVersion: input.settlementVersion,
    calculationVersion: input.calculationVersion,
    ruleset: { name: input.rulesetName, version: input.rulesetVersion },
    contestRules: input.contestRules,
    entryFeeBaseUnits: input.entryFeeBaseUnits,
    seatCount: input.seatCount,
    confirmedEntries: input.computation.rows.length,
    feePolicy: {
      id: input.feePolicy.id,
      version: input.feePolicy.version,
      rateBps: input.feePolicy.rateBps,
      label: input.feePolicy.label ?? "DEV",
    },
    payoutPolicy: {
      id: input.payoutPolicy.id,
      version: input.payoutPolicy.version,
      policyType: input.payoutPolicy.policyType,
      configuration: input.payoutPolicy.configuration,
    },
    tiePolicy: input.computation.tiePolicy,
    entries: input.computation.rows.map((row: PayoutRow) => ({
      entryId: row.entryId,
      teamVersionId: row.teamVersionId,
      xi: row.xi,
      captainId: row.captainId,
      viceId: row.viceId,
      baseScoreMilliPoints: row.baseScoreMilliPoints,
      finalScoreMilliPoints: row.finalScoreMilliPoints,
      rank: row.rank,
      resultStatus: row.resultStatus,
      payoutAmountBaseUnits: row.netPayoutBaseUnits,
      destinationWallet: row.destinationWallet,
      grossAllocationBaseUnits: row.grossAllocationBaseUnits,
      feeAllocationBaseUnits: row.feeAllocationBaseUnits,
    })),
    totals: {
      totalPotBaseUnits: input.computation.totalPotBaseUnits,
      feeBaseUnits: input.computation.feeBaseUnits,
      totalPayoutBaseUnits: input.computation.totalPayoutBaseUnits,
    },
  };
}

export function hashResultPayload(payload: ImmutableResultPayload): string {
  return computeResultHash(payload);
}
