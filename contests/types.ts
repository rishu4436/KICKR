import type { ContestState } from "../domain/state-machine.js";

/** USDC integer base units. 1 USDC = 1_000_000. Never a float. */
export const USDC_BASE_UNITS = 1_000_000;
export const USDC_CURRENCY = "USDC" as const;

export type ContestType = "HEAD_TO_HEAD" | "WINNER_TAKES_ALL" | "GRAND_LEAGUE";
export type ReservationStatus = "PENDING" | "EXPIRED" | "CANCELLED" | "CONFIRMED";
export type EntryStatus = "PENDING" | "CONFIRMED" | "REFUNDED" | "CANCELLED";

export interface PayoutPolicyRecord {
  id: string;
  version: number;
  policyType: ContestType;
  configuration: Record<string, unknown>;
  createdAt: string;
}

export interface FeePolicyRecord {
  id: string;
  version: number;
  /** Integer basis points. Development seed only. TODO: production bps. */
  rateBps: number;
  configuration: Record<string, unknown>;
  createdAt: string;
}

export interface ContestTemplateRecord {
  id: string;
  templateCode: string;
  contestType: ContestType;
  entryFeeBaseUnits: number;
  capacity: number;
  payoutPolicyId: string;
  payoutPolicyVersion: number;
  feePolicyId: string;
  feePolicyVersion: number;
  currency: typeof USDC_CURRENCY;
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * Frozen at contest creation. Later template edits must not change this object.
 * There is no application update path.
 */
export interface RulesSnapshot {
  templateId: string;
  templateCode: string;
  templateVersion: number;
  entryFeeBaseUnits: number;
  capacity: number;
  contestType: ContestType;
  payoutPolicyId: string;
  payoutPolicyVersion: number;
  payoutPolicyType: ContestType;
  payoutConfiguration: Record<string, unknown>;
  feePolicyId: string;
  feePolicyVersion: number;
  feeRateBps: number;
  feeConfiguration: Record<string, unknown>;
  scoringRulesetId: string;
  scoringRulesetVersion: number;
  scoringRulesetName: string;
  matchId: string;
  lockTime: string;
  currency: typeof USDC_CURRENCY;
}

export interface ContestRecord {
  id: string;
  templateId: string;
  matchId: string;
  contestType: ContestType;
  status: ContestState;
  capacity: number;
  filledCount: number;
  entryFeeBaseUnits: number;
  currency: typeof USDC_CURRENCY;
  rulesSnapshot: RulesSnapshot;
  createdAt: string;
  updatedAt: string;
  lockedAt: string | null;
  completedAt: string | null;
}

/**
 * Not an escrow address. reference stays null until Phase 4 binds a program account.
 * No USDC moves because this object exists.
 */
export interface EscrowPlaceholder {
  kind: "ESCROW_PLACEHOLDER";
  reference: null;
  todo: string;
}

export const ESCROW_PLACEHOLDER: EscrowPlaceholder = {
  kind: "ESCROW_PLACEHOLDER",
  reference: null,
  todo: "Phase 4 may bind a program account. This is not an escrow address and no USDC moves.",
};

export interface ReservationRecord {
  id: string;
  contestId: string;
  wallet: string;
  teamVersionId: string;
  amountBaseUnits: number;
  currency: typeof USDC_CURRENCY;
  nonce: string;
  escrowPlaceholder: EscrowPlaceholder;
  issuedAt: string;
  expiresAt: string;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EntryRecord {
  id: string;
  contestId: string;
  wallet: string;
  teamVersionId: string;
  reservationId: string;
  status: EntryStatus;
  seatNumber: number;
  joinedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxRecord {
  id: string;
  eventType: "CONTEST_FILLED";
  contestId: string;
  payload: Record<string, unknown>;
  createdAt: string;
  publishedAt: string | null;
}

export interface ContestLimits {
  /** TODO: unset means do not invent a per-match entry cap. */
  maxEntriesPerMatch: number | null;
  /** TODO: unset means do not invent an extra per-contest cap. Duplicate wallet is still forbidden. */
  maxEntriesPerContest: number | null;
  /** TODO: unset means do not invent a USDC exposure cap. Integer base units when set. */
  maxExposurePerMatch: number | null;
}

export interface DiscoveryView {
  matchId: string;
  contestId: string;
  templateId: string;
  templateCode: string;
  contestType: ContestType;
  entryFeeBaseUnits: number;
  currency: typeof USDC_CURRENCY;
  capacity: number;
  filledCount: number;
  remaining: number;
  status: ContestState;
  lockTime: string;
  estimatedPrizePoolBaseUnits: number;
  estimated: true;
  funded: false;
  estimateLabel: "filled entries times entry fee; not funded money";
}

export function assertBaseUnits(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer base-unit amount`);
  }
  return value;
}

export function wholeUsdc(whole: number): number {
  if (!Number.isInteger(whole) || whole < 0) {
    throw new Error("USDC whole units must be a non-negative integer");
  }
  return assertBaseUnits(whole * USDC_BASE_UNITS, "USDC amount");
}
