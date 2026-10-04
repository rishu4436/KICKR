/**
 * Independent verification of settlement / claim txs.
 * Same philosophy as Phase 4.1 deposits: SUBMITTED ≠ CONFIRMED.
 */

export interface SettlementCommitObservation {
  labelledFixture: boolean;
  signature: string;
  commitment: string;
  slot: number;
  succeeded: boolean;
  programId: string;
  authority: string;
  contestPda: string;
  settlementPda: string;
  settlementVersion: number;
  resultHash: string;
  merkleRoot: string;
  totalPayoutBaseUnits: number;
  feeBaseUnits: number;
  contestStatusAfter: number;
}

export interface ClaimObservation {
  labelledFixture: boolean;
  signature: string;
  commitment: string;
  slot: number;
  succeeded: boolean;
  programId: string;
  claimant: string;
  contestPda: string;
  settlementVersion: number;
  entryId: string;
  amountBaseUnits: number;
  mint: string;
  vault: string;
  claimPda: string;
  destination: string;
  vaultBalanceDecrease: number;
}

export type VerifyDecision =
  | { ok: true; idempotent?: boolean }
  | { ok: false; reason: string };

const FINALIZED = "finalized";

export function decideSettlementCommit(input: {
  observation: SettlementCommitObservation;
  programId: string;
  expectedAuthority: string;
  expectedContestPda: string;
  expectedVersion: number;
  expectedResultHash: string;
  expectedMerkleRoot: string;
  expectedTotalPayout: number;
  expectedFee: number;
  existingSignature: string | null;
}): VerifyDecision {
  const o = input.observation;
  if (o.commitment !== FINALIZED) return { ok: false, reason: "NOT_FINALIZED" };
  if (!o.succeeded) return { ok: false, reason: "TRANSACTION_FAILED" };
  if (o.programId !== input.programId) return { ok: false, reason: "WRONG_PROGRAM" };
  if (o.authority !== input.expectedAuthority) return { ok: false, reason: "INVALID_AUTHORITY" };
  if (o.contestPda !== input.expectedContestPda) return { ok: false, reason: "WRONG_CONTEST" };
  if (o.settlementVersion !== input.expectedVersion) return { ok: false, reason: "WRONG_VERSION" };
  if (o.resultHash !== input.expectedResultHash) return { ok: false, reason: "WRONG_RESULT_HASH" };
  if (o.merkleRoot !== input.expectedMerkleRoot) return { ok: false, reason: "WRONG_MERKLE_ROOT" };
  if (o.totalPayoutBaseUnits !== input.expectedTotalPayout) return { ok: false, reason: "WRONG_AMOUNT" };
  if (o.feeBaseUnits !== input.expectedFee) return { ok: false, reason: "WRONG_FEE" };
  if (input.existingSignature && input.existingSignature === o.signature) {
    return { ok: true, idempotent: true };
  }
  if (input.existingSignature && input.existingSignature !== o.signature) {
    return { ok: false, reason: "DUPLICATE_SETTLEMENT" };
  }
  return { ok: true };
}

export function decideClaim(input: {
  observation: ClaimObservation;
  programId: string;
  expectedClaimant: string;
  expectedContestPda: string;
  expectedVersion: number;
  expectedEntryId: string;
  expectedAmount: number;
  expectedMint: string;
  expectedVault: string;
  expectedClaimPda: string;
  existingSignature: string | null;
}): VerifyDecision {
  const o = input.observation;
  if (o.commitment !== FINALIZED) return { ok: false, reason: "NOT_FINALIZED" };
  if (!o.succeeded) return { ok: false, reason: "TRANSACTION_FAILED" };
  if (o.programId !== input.programId) return { ok: false, reason: "WRONG_PROGRAM" };
  if (o.claimant !== input.expectedClaimant) return { ok: false, reason: "WRONG_WALLET" };
  if (o.contestPda !== input.expectedContestPda) return { ok: false, reason: "WRONG_CONTEST" };
  if (o.settlementVersion !== input.expectedVersion) return { ok: false, reason: "WRONG_VERSION" };
  if (o.entryId !== input.expectedEntryId) return { ok: false, reason: "WRONG_ENTRY" };
  if (o.amountBaseUnits !== input.expectedAmount) return { ok: false, reason: "WRONG_AMOUNT" };
  if (o.mint !== input.expectedMint) return { ok: false, reason: "WRONG_MINT" };
  if (o.vault !== input.expectedVault) return { ok: false, reason: "WRONG_VAULT" };
  if (o.claimPda !== input.expectedClaimPda) return { ok: false, reason: "WRONG_CLAIM_PDA" };
  if (o.destination !== input.expectedClaimant) return { ok: false, reason: "ARBITRARY_DESTINATION" };
  if (o.vaultBalanceDecrease !== o.amountBaseUnits) return { ok: false, reason: "VAULT_DECREASE_MISMATCH" };
  if (input.existingSignature && input.existingSignature === o.signature) {
    return { ok: true, idempotent: true };
  }
  if (input.existingSignature) return { ok: false, reason: "DUPLICATE_CLAIM" };
  return { ok: true };
}
