import type { ImmutableResultPayload } from "./result-payload.js";
import type { SettlementState } from "./states.js";

export interface SettlementRecord {
  id: string;
  contestId: string;
  matchId: string;
  settlementVersion: number;
  status: SettlementState | string;
  resultHash: string;
  merkleRoot: string | null;
  settlementHash: string | null;
  calculationVersion: number;
  feePolicyId: string;
  feePolicyVersion: number;
  feeRateBps: number;
  payoutPolicyId: string;
  payoutPolicyVersion: number;
  payoutPolicyType: string;
  payoutConfiguration: unknown;
  rulesetName: string;
  rulesetVersion: number;
  entryFeeBaseUnits: number;
  seatCount: number;
  confirmedEntries: number;
  totalPotBaseUnits: number;
  feeBaseUnits: number;
  totalPayoutBaseUnits: number;
  commitSignature: string | null;
  confirmedSlot: number | null;
  confirmedAt: string | null;
  failureReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  payload: ImmutableResultPayload;
}

export interface SettlementResultRow {
  id: string;
  settlementId: string;
  contestId: string;
  entryId: string;
  teamVersionId: string;
  destinationWallet: string;
  rank: number;
  baseScoreMilliPoints: number;
  finalScoreMilliPoints: number;
  resultStatus: string;
  xi: string[];
  captainId: string;
  viceId: string;
  grossAllocationBaseUnits: number;
  feeAllocationBaseUnits: number;
  netPayoutBaseUnits: number;
  leafHash: string;
  claimStatus: "UNCLAIMED" | "SUBMITTED" | "CLAIMED" | "FAILED";
  claimSignature: string | null;
  claimedAt: string | null;
  createdAt: string;
}
