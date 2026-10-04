import { Connection, type VersionedTransactionResponse } from "@solana/web3.js";
import { anchorDiscriminator, bytesToUuid, toHex } from "./escrow.js";
import type { DepositObservation } from "./verify.js";
import type { ClaimObservation } from "../settlement/verify.js";

export class RpcUnavailable extends Error {
  constructor() {
    super("Solana RPC unavailable");
    this.name = "RpcUnavailable";
  }
}

/**
 * Reads one transaction at commitment "finalized".
 * Null means the signature is not finalized yet. That is not a confirmation.
 * A thrown RPC call becomes RpcUnavailable and must leave the entry PENDING.
 */
export async function observeFinalizedDeposit(
  rpcUrl: string,
  signature: string,
  programId: string,
): Promise<DepositObservation | null> {
  const connection = new Connection(rpcUrl, "finalized");
  let tx: VersionedTransactionResponse | null;
  try {
    tx = await connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    throw new RpcUnavailable();
  }
  if (!tx || !tx.meta) {
    return tx ? observationFromResponse(tx, signature, programId) : null;
  }
  return observationFromResponse(tx, signature, programId);
}

export function observationFromResponse(
  tx: VersionedTransactionResponse,
  signature: string,
  expectedProgramId: string,
): DepositObservation {
  const slot = tx.slot;
  const blockTime = tx.blockTime ?? null;
  const succeeded = tx.meta?.err == null;
  const empty = emptyObservation(signature, expectedProgramId, slot, blockTime, succeeded);
  const meta = tx.meta;
  if (!meta) {
    return { ...empty, succeeded: false };
  }
  const accountKeys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: meta.loadedAddresses ?? null,
  });
  const keys = Array.from({ length: accountKeys.length }, (_, index) => accountKeys.get(index)?.toBase58() ?? "");
  const discriminator = anchorDiscriminator("deposit");
  const match = tx.transaction.message.compiledInstructions.find((instruction) => {
    const program = keys[instruction.programIdIndex];
    if (program !== expectedProgramId || instruction.data.length < 8) {
      return false;
    }
    for (let index = 0; index < 8; index += 1) {
      if (instruction.data[index] !== discriminator[index]) {
        return false;
      }
    }
    return true;
  });
  if (!match || match.data.length < 56 || match.accountKeyIndexes.length < 7) {
    return { ...empty, succeeded: false };
  }
  const view = new DataView(match.data.buffer, match.data.byteOffset, match.data.byteLength);
  const amount = Number(view.getBigUint64(8, true));
  const sender = keys[match.accountKeyIndexes[0] ?? -1] ?? "";
  const mint = keys[match.accountKeyIndexes[2] ?? -1] ?? "";
  const contestPda = keys[match.accountKeyIndexes[3] ?? -1] ?? "";
  const vault = keys[match.accountKeyIndexes[4] ?? -1] ?? "";
  const depositReceipt = keys[match.accountKeyIndexes[5] ?? -1] ?? "";
  const tokenProgram = keys[match.accountKeyIndexes[6] ?? -1] ?? "";
  const vaultIndex = keys.indexOf(vault);
  let teamVersionId: string;
  try {
    teamVersionId = bytesToUuid(match.data.subarray(48, 64));
  } catch {
    return { ...empty, succeeded: false };
  }
  return {
    labelledFixture: false,
    signature,
    commitment: "finalized",
    slot,
    blockTime,
    succeeded,
    programId: expectedProgramId,
    sender,
    mint,
    vault,
    contestPda,
    depositReceipt,
    tokenProgram,
    amountBaseUnits: amount,
    reservationNonceHash: toHex(match.data.subarray(16, 48)),
    teamVersionId,
    vaultBalanceIncrease: tokenIncrease(meta.preTokenBalances, meta.postTokenBalances, vaultIndex),
  };
}

function emptyObservation(
  signature: string,
  programId: string,
  slot: number,
  blockTime: number | null,
  succeeded: boolean,
): DepositObservation {
  return {
    labelledFixture: false,
    signature,
    commitment: "finalized",
    slot,
    blockTime,
    succeeded,
    programId,
    sender: "",
    mint: "",
    vault: "",
    contestPda: "",
    depositReceipt: "",
    tokenProgram: "",
    amountBaseUnits: 0,
    reservationNonceHash: "",
    teamVersionId: "00000000-0000-0000-0000-000000000000",
    vaultBalanceIncrease: 0,
  };
}

function tokenIncrease(
  pre: ReadonlyArray<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null | undefined,
  post: ReadonlyArray<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null | undefined,
  accountIndex: number,
): number {
  if (accountIndex < 0) {
    return 0;
  }
  return rawAmount(post, accountIndex) - rawAmount(pre, accountIndex);
}

function rawAmount(balances: ReadonlyArray<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null | undefined, accountIndex: number): number {
  const row = balances?.find((balance) => balance.accountIndex === accountIndex);
  if (!row || !/^[0-9]+$/.test(row.uiTokenAmount.amount)) {
    return 0;
  }
  const amount = Number(row.uiTokenAmount.amount);
  return Number.isSafeInteger(amount) ? amount : Number.NaN;
}


/**
 * Observe a finalized claim_payout. Null = not finalized yet (keep confirming).
 * RpcUnavailable must leave claim SUBMITTED / confirming — never mark FAILED on timeout.
 */
export async function observeFinalizedClaim(
  rpcUrl: string,
  signature: string,
  programId: string,
): Promise<ClaimObservation | null> {
  const connection = new Connection(rpcUrl, "finalized");
  let tx: VersionedTransactionResponse | null;
  try {
    tx = await connection.getTransaction(signature, {
      commitment: "finalized",
      maxSupportedTransactionVersion: 0,
    });
  } catch {
    throw new RpcUnavailable();
  }
  if (!tx) {
    return null;
  }
  return claimObservationFromResponse(tx, signature, programId);
}

export function claimObservationFromResponse(
  tx: VersionedTransactionResponse,
  signature: string,
  expectedProgramId: string,
): ClaimObservation {
  const slot = tx.slot;
  const succeeded = tx.meta?.err == null;
  const empty: ClaimObservation = {
    labelledFixture: false,
    signature,
    commitment: "finalized",
    slot,
    succeeded,
    programId: expectedProgramId,
    claimant: "",
    contestPda: "",
    settlementVersion: 0,
    entryId: "00000000-0000-0000-0000-000000000000",
    amountBaseUnits: 0,
    mint: "",
    vault: "",
    claimPda: "",
    destination: "",
    vaultBalanceDecrease: 0,
  };
  const meta = tx.meta;
  if (!meta) {
    return { ...empty, succeeded: false };
  }
  const accountKeys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: meta.loadedAddresses ?? null,
  });
  const keys = Array.from({ length: accountKeys.length }, (_, index) => accountKeys.get(index)?.toBase58() ?? "");
  const discriminator = anchorDiscriminator("claim_payout");
  const match = tx.transaction.message.compiledInstructions.find((instruction) => {
    const program = keys[instruction.programIdIndex];
    if (program !== expectedProgramId || instruction.data.length < 8) {
      return false;
    }
    for (let index = 0; index < 8; index += 1) {
      if (instruction.data[index] !== discriminator[index]) {
        return false;
      }
    }
    return true;
  });
  // keys: claimant, contest, settlement, claim, mint, vault, claimantToken, ...
  if (!match || match.data.length < 40 || match.accountKeyIndexes.length < 7) {
    return { ...empty, succeeded: false };
  }
  const view = new DataView(match.data.buffer, match.data.byteOffset, match.data.byteLength);
  const settlementVersion = view.getUint32(8, true);
  let entryId: string;
  try {
    entryId = bytesToUuid(match.data.subarray(12, 28));
  } catch {
    return { ...empty, succeeded: false };
  }
  const amountBaseUnits = Number(view.getBigUint64(28, true));
  const claimant = keys[match.accountKeyIndexes[0] ?? -1] ?? "";
  const contestPda = keys[match.accountKeyIndexes[1] ?? -1] ?? "";
  const claimPda = keys[match.accountKeyIndexes[3] ?? -1] ?? "";
  const mint = keys[match.accountKeyIndexes[4] ?? -1] ?? "";
  const vault = keys[match.accountKeyIndexes[5] ?? -1] ?? "";
  const vaultIndex = keys.indexOf(vault);
  const vaultBalanceDecrease = tokenDecrease(meta.preTokenBalances, meta.postTokenBalances, vaultIndex);
  return {
    labelledFixture: false,
    signature,
    commitment: "finalized",
    slot,
    succeeded,
    programId: expectedProgramId,
    claimant,
    contestPda,
    settlementVersion,
    entryId,
    amountBaseUnits,
    mint,
    vault,
    claimPda,
    destination: claimant,
    vaultBalanceDecrease,
  };
}

function tokenDecrease(
  pre: ReadonlyArray<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null | undefined,
  post: ReadonlyArray<{ accountIndex: number; uiTokenAmount: { amount: string } }> | null | undefined,
  accountIndex: number,
): number {
  if (accountIndex < 0) {
    return 0;
  }
  return rawAmount(pre, accountIndex) - rawAmount(post, accountIndex);
}
