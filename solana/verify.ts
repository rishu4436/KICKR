import { PublicKey } from "@solana/web3.js";
import { bytesToUuid, nonceHash, toHex, uuidToBytes, deriveContestPda, deriveDepositReceipt, deriveVaultAddress } from "./escrow.js";

/**
 * A chain observation. Production RPC must set labelledFixture to false.
 * Tests may set labelledFixture true. The flag never makes a deposit valid.
 */
export interface DepositObservation {
  labelledFixture: boolean;
  signature: string;
  commitment: string;
  slot: number;
  blockTime: number | null;
  succeeded: boolean;
  programId: string;
  sender: string;
  mint: string;
  vault: string;
  contestPda: string;
  depositReceipt: string;
  tokenProgram: string;
  amountBaseUnits: number;
  reservationNonceHash: string;
  teamVersionId: string;
  vaultBalanceIncrease: number;
}

export interface ReservationMatch {
  reservationId: string;
  contestId: string;
  wallet: string;
  teamVersionId: string;
  amountBaseUnits: number;
  nonce: string;
  expiresAt: string;
  status: string;
  entryStatus: string;
  entryId: string;
  existingSignature: string | null;
}

export interface VerifyInput {
  observation: DepositObservation;
  programId: string;
  mint: string;
  tokenProgram: string;
  reservation: ReservationMatch | null;
}

export type VerifyDecision =
  | { ok: true; reservationId: string; idempotent: boolean }
  | { ok: false; reason: string };

const FINALIZED = "finalized";

export function decideDeposit(input: VerifyInput): VerifyDecision {
  const observed = input.observation;
  if (observed.commitment !== FINALIZED) {
    return { ok: false, reason: "NOT_FINALIZED" };
  }
  if (!observed.succeeded) {
    return { ok: false, reason: "TRANSACTION_FAILED" };
  }
  if (observed.programId !== input.programId) {
    return { ok: false, reason: "WRONG_PROGRAM" };
  }
  const reservation = input.reservation;
  if (!reservation) {
    return { ok: false, reason: "UNKNOWN_RESERVATION" };
  }
  if (reservation.wallet !== observed.sender) {
    return { ok: false, reason: "WRONG_WALLET" };
  }
  if (toHex(nonceHash(reservation.nonce)) !== observed.reservationNonceHash) {
    return { ok: false, reason: "NONCE_MISMATCH" };
  }
  if (reservation.teamVersionId !== observed.teamVersionId) {
    return { ok: false, reason: "TEAM_VERSION_MISMATCH" };
  }
  if (observed.amountBaseUnits !== reservation.amountBaseUnits || !Number.isSafeInteger(observed.amountBaseUnits)) {
    return { ok: false, reason: "WRONG_AMOUNT" };
  }
  if (observed.mint !== input.mint) {
    return { ok: false, reason: "WRONG_MINT" };
  }
  if (observed.tokenProgram !== input.tokenProgram) {
    return { ok: false, reason: "WRONG_TOKEN_PROGRAM" };
  }
  let expectedContest: string;
  let expectedVault: string;
  let expectedReceipt: string;
  try {
    const programKey = new PublicKey(input.programId);
    const contestPda = deriveContestPda(programKey, uuidToBytes(reservation.contestId));
    expectedContest = contestPda.toBase58();
    expectedVault = deriveVaultAddress(
      new PublicKey(input.mint),
      contestPda,
      new PublicKey(input.tokenProgram),
    ).toBase58();
    expectedReceipt = deriveDepositReceipt(programKey, contestPda, new PublicKey(reservation.wallet)).toBase58();
  } catch {
    return { ok: false, reason: "ACCOUNT_DERIVATION_FAILED" };
  }
  if (observed.contestPda !== expectedContest) {
    return { ok: false, reason: "WRONG_CONTEST" };
  }
  if (observed.vault !== expectedVault) {
    return { ok: false, reason: "WRONG_DESTINATION" };
  }
  if (observed.depositReceipt !== expectedReceipt) {
    return { ok: false, reason: "RECEIPT_MISMATCH" };
  }
  if (observed.vaultBalanceIncrease !== observed.amountBaseUnits) {
    return { ok: false, reason: "VAULT_BALANCE_MISMATCH" };
  }
  const observedAt = observed.blockTime === null ? null : observed.blockTime * 1000;
  if (observedAt !== null && observedAt >= Date.parse(reservation.expiresAt)) {
    return { ok: false, reason: "EXPIRED" };
  }
  if (reservation.existingSignature && reservation.existingSignature !== observed.signature && reservation.entryStatus === "CONFIRMED") {
    return { ok: false, reason: "DUPLICATE" };
  }
  if (reservation.entryStatus === "CONFIRMED" && reservation.existingSignature === observed.signature) {
    return { ok: true, reservationId: reservation.reservationId, idempotent: true };
  }
  if (reservation.status !== "PENDING" || reservation.entryStatus !== "PENDING") {
    return { ok: false, reason: "RESERVATION_NOT_PENDING" };
  }
  return { ok: true, reservationId: reservation.reservationId, idempotent: false };
}

export function teamVersionFromBytes(bytes: Uint8Array): string {
  return bytesToUuid(bytes);
}
