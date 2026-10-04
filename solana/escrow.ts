import { sha256 } from "@noble/hashes/sha256";
import { getAssociatedTokenAddressSync, ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";

export const CONFIG_SEED = new TextEncoder().encode("config");
export const CONTEST_SEED = new TextEncoder().encode("contest");
export const DEPOSIT_SEED = new TextEncoder().encode("deposit");

export interface EscrowClientConfig {
  programId: string;
  usdcMint: string;
  usdcDecimals: number;
  cluster: string;
  tokenProgramId?: string;
}

export interface DepositPlan {
  cluster: string;
  programId: string;
  contestId: string;
  mint: string;
  decimals: number;
  tokenProgramId: string;
  contestPda: string;
  vault: string;
  depositReceipt: string;
  feeBaseUnits: number;
  teamVersionId: string;
  reservationNonce: string;
  reservationNonceHash: string;
  expiresAt: string;
}

export function uuidToBytes(id: string): Uint8Array {
  const hex = id.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) {
    throw new Error("Expected a UUID");
  }
  const out = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

export function bytesToUuid(bytes: Uint8Array): string {
  if (bytes.length !== 16) {
    throw new Error("Expected 16 bytes");
  }
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function nonceHash(nonce: string): Uint8Array {
  return sha256(new TextEncoder().encode(nonce));
}

export function anchorDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

export function deriveConfigPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([CONFIG_SEED], programId)[0];
}

export function deriveContestPda(programId: PublicKey, contestId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([CONTEST_SEED, contestId], programId)[0];
}

export function deriveDepositReceipt(programId: PublicKey, contestPda: PublicKey, depositor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([DEPOSIT_SEED, contestPda.toBuffer(), depositor.toBuffer()], programId)[0];
}

export function deriveVaultAddress(mint: PublicKey, contestPda: PublicKey, tokenProgramId: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, contestPda, true, tokenProgramId);
}

export function buildDepositPlan(input: {
  config: EscrowClientConfig;
  contestId: string;
  wallet: string;
  teamVersionId: string;
  reservationNonce: string;
  feeBaseUnits: number;
  expiresAt: string;
}): DepositPlan {
  if (!input.config.usdcMint) {
    throw new Error("USDC mint is not configured");
  }
  if (!Number.isInteger(input.config.usdcDecimals) || input.config.usdcDecimals < 0 || input.config.usdcDecimals > 9) {
    throw new Error("USDC decimals must be an integer from 0 to 9");
  }
  const programId = new PublicKey(input.config.programId);
  const mint = new PublicKey(input.config.usdcMint);
  const wallet = new PublicKey(input.wallet);
  const tokenProgramId = new PublicKey(input.config.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58());
  const contestPda = deriveContestPda(programId, uuidToBytes(input.contestId));
  const vault = deriveVaultAddress(mint, contestPda, tokenProgramId);
  const depositReceipt = deriveDepositReceipt(programId, contestPda, wallet);
  const hash = nonceHash(input.reservationNonce);
  return {
    cluster: input.config.cluster,
    programId: programId.toBase58(),
    contestId: input.contestId,
    mint: mint.toBase58(),
    decimals: input.config.usdcDecimals,
    tokenProgramId: tokenProgramId.toBase58(),
    contestPda: contestPda.toBase58(),
    vault: vault.toBase58(),
    depositReceipt: depositReceipt.toBase58(),
    feeBaseUnits: input.feeBaseUnits,
    teamVersionId: input.teamVersionId,
    reservationNonce: input.reservationNonce,
    reservationNonceHash: toHex(hash),
    expiresAt: input.expiresAt,
  };
}

export function buildDepositTransaction(input: {
  plan: DepositPlan;
  feePayer: PublicKey;
  recentBlockhash: string;
}): Transaction {
  const programId = new PublicKey(input.plan.programId);
  const user = new PublicKey(input.feePayer);
  const data = new Uint8Array(8 + 8 + 32 + 16);
  data.set(anchorDiscriminator("deposit"), 0);
  const view = new DataView(data.buffer);
  view.setBigUint64(8, BigInt(input.plan.feeBaseUnits), true);
  data.set(nonceHash(input.plan.reservationNonce), 16);
  data.set(uuidToBytes(input.plan.teamVersionId), 48);
  const keys = [
    { pubkey: user, isSigner: true, isWritable: true },
    { pubkey: deriveUserAta(input.plan, user), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(input.plan.mint), isSigner: false, isWritable: false },
    { pubkey: new PublicKey(input.plan.contestPda), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(input.plan.vault), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(input.plan.depositReceipt), isSigner: false, isWritable: true },
    { pubkey: new PublicKey(input.plan.tokenProgramId), isSigner: false, isWritable: false },
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
  ];
  const tx = new Transaction({
    feePayer: input.feePayer,
    recentBlockhash: input.recentBlockhash,
  });
  tx.add(new TransactionInstruction({ keys, programId, data: Buffer.from(data) }));
  return tx;
}

function deriveUserAta(plan: DepositPlan, user: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    new PublicKey(plan.mint),
    user,
    false,
    new PublicKey(plan.tokenProgramId),
  );
}

export function getContestEscrowState(plan: Pick<DepositPlan, "programId" | "contestId" | "mint" | "tokenProgramId">): {
  contestPda: string;
  vault: string;
} {
  const programId = new PublicKey(plan.programId);
  const contestPda = deriveContestPda(programId, uuidToBytes(plan.contestId));
  const vault = deriveVaultAddress(new PublicKey(plan.mint), contestPda, new PublicKey(plan.tokenProgramId));
  return { contestPda: contestPda.toBase58(), vault: vault.toBase58() };
}
