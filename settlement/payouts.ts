import { compareTiedEntries, TIE_POLICY_ID } from "./tie-policy.js";

export interface RankedEntryInput {
  entryId: string;
  teamVersionId: string;
  destinationWallet: string;
  finalScoreMilliPoints: number;
  baseScoreMilliPoints: number;
  xi: string[];
  captainId: string;
  viceId: string;
}

export interface FrozenPayoutPolicy {
  id: string;
  version: number;
  policyType: "HEAD_TO_HEAD" | "WINNER_TAKES_ALL" | "GRAND_LEAGUE";
  configuration: {
    shape?: string;
    calculation?: string;
    tiePolicy?: string;
    ranks?: Array<{
      rank?: number;
      bps?: number;
      rankFrom?: number;
      rankTo?: number;
      bpsEach?: number;
    }>;
    note?: string;
  };
}

export interface FrozenFeePolicy {
  id: string;
  version: number;
  rateBps: number;
  label?: string;
}

export interface PayoutRow {
  entryId: string;
  teamVersionId: string;
  destinationWallet: string;
  rank: number;
  baseScoreMilliPoints: number;
  finalScoreMilliPoints: number;
  resultStatus: "RANKED";
  xi: string[];
  captainId: string;
  viceId: string;
  grossAllocationBaseUnits: number;
  feeAllocationBaseUnits: number;
  netPayoutBaseUnits: number;
}

export interface PayoutComputation {
  tiePolicy: typeof TIE_POLICY_ID;
  feeRateBps: number;
  totalPotBaseUnits: number;
  feeBaseUnits: number;
  prizePoolBaseUnits: number;
  totalPayoutBaseUnits: number;
  rows: PayoutRow[];
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer base unit`);
  }
}

export function rankEntries(entries: RankedEntryInput[]): Array<RankedEntryInput & { rank: number }> {
  const sorted = [...entries].sort(compareTiedEntries);
  return sorted.map((entry, index) => ({ ...entry, rank: index + 1 }));
}

function bpsOf(amount: number, bps: number): number {
  return Math.floor((amount * bps) / 10_000);
}

function resolveRankBps(policy: FrozenPayoutPolicy, rank: number): number {
  const ranks = policy.configuration.ranks ?? [];
  for (const row of ranks) {
    if (row.rank === rank && row.bps !== undefined) {
      return row.bps;
    }
    if (
      row.rankFrom !== undefined &&
      row.rankTo !== undefined &&
      row.bpsEach !== undefined &&
      rank >= row.rankFrom &&
      rank <= row.rankTo
    ) {
      return row.bpsEach;
    }
  }
  return 0;
}

/**
 * Payouts from confirmed entry fees + frozen fee policy + frozen payout policy.
 * Integer USDC base units only. Invariant: sum(net payouts) + fees == pot.
 *
 * Tie policy: entry_id_asc (see tie-policy.ts). Fee bps labelled DEV at 1000.
 */
export function computePayouts(input: {
  entries: RankedEntryInput[];
  entryFeeBaseUnits: number;
  feePolicy: FrozenFeePolicy;
  payoutPolicy: FrozenPayoutPolicy;
}): PayoutComputation {
  assertInteger(input.entryFeeBaseUnits, "entryFeeBaseUnits");
  assertInteger(input.feePolicy.rateBps, "feeRateBps");
  if (input.entries.length === 0) {
    throw new Error("cannot settle a contest with zero confirmed entries");
  }
  const tiePolicy = input.payoutPolicy.configuration.tiePolicy ?? TIE_POLICY_ID;
  if (tiePolicy !== TIE_POLICY_ID) {
    throw new Error(`unsupported tie policy: ${tiePolicy}`);
  }

  const ranked = rankEntries(input.entries);
  const totalPot = input.entryFeeBaseUnits * input.entries.length;
  assertInteger(totalPot, "totalPot");
  const policyFee = bpsOf(totalPot, input.feePolicy.rateBps);
  const prizePool = totalPot - policyFee;

  const calculation = input.payoutPolicy.configuration.calculation ?? "none";
  const netByEntry = new Map<string, number>();

  if (
    calculation === "winner_takes_prize_pool" ||
    (calculation === "none" &&
      (input.payoutPolicy.policyType === "HEAD_TO_HEAD" ||
        input.payoutPolicy.policyType === "WINNER_TAKES_ALL"))
  ) {
    netByEntry.set(ranked[0]!.entryId, prizePool);
    for (const row of ranked.slice(1)) {
      netByEntry.set(row.entryId, 0);
    }
  } else if (calculation === "rank_bps" || input.payoutPolicy.policyType === "GRAND_LEAGUE") {
    let allocated = 0;
    for (const row of ranked) {
      const amount = bpsOf(prizePool, resolveRankBps(input.payoutPolicy, row.rank));
      netByEntry.set(row.entryId, amount);
      allocated += amount;
    }
    if (allocated > prizePool) {
      throw new Error("rank_bps allocation exceeds prize pool");
    }
  } else {
    throw new Error(`unsupported payout calculation: ${calculation}`);
  }

  const totalPayout = [...netByEntry.values()].reduce((sum, value) => sum + value, 0);
  const effectiveFee = totalPot - totalPayout;
  if (effectiveFee < 0 || totalPayout + effectiveFee !== totalPot) {
    throw new Error("payout invariant violated: sum(payouts)+fees must equal pot");
  }

  const rows: PayoutRow[] = [];
  let feeAssigned = 0;
  for (let i = 0; i < ranked.length; i += 1) {
    const entry = ranked[i]!;
    const net = netByEntry.get(entry.entryId) ?? 0;
    let feeShare: number;
    if (i === ranked.length - 1) {
      feeShare = effectiveFee - feeAssigned;
    } else if (totalPayout === 0) {
      feeShare = i === 0 ? effectiveFee : 0;
      feeAssigned += feeShare;
    } else {
      feeShare = Math.floor((effectiveFee * net) / totalPayout);
      feeAssigned += feeShare;
    }
    rows.push({
      entryId: entry.entryId,
      teamVersionId: entry.teamVersionId,
      destinationWallet: entry.destinationWallet,
      rank: entry.rank,
      baseScoreMilliPoints: entry.baseScoreMilliPoints,
      finalScoreMilliPoints: entry.finalScoreMilliPoints,
      resultStatus: "RANKED",
      xi: [...entry.xi],
      captainId: entry.captainId,
      viceId: entry.viceId,
      grossAllocationBaseUnits: net + feeShare,
      feeAllocationBaseUnits: feeShare,
      netPayoutBaseUnits: net,
    });
  }

  const sumNet = rows.reduce((sum, row) => sum + row.netPayoutBaseUnits, 0);
  const sumFee = rows.reduce((sum, row) => sum + row.feeAllocationBaseUnits, 0);
  if (sumNet + sumFee !== totalPot) {
    throw new Error("per-row fee attribution invariant failed");
  }

  return {
    tiePolicy: TIE_POLICY_ID,
    feeRateBps: input.feePolicy.rateBps,
    totalPotBaseUnits: totalPot,
    feeBaseUnits: effectiveFee,
    prizePoolBaseUnits: prizePool,
    totalPayoutBaseUnits: sumNet,
    rows,
  };
}
