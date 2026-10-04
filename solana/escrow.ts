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
export const SETTLEMENT_SEED = new TextEncoder().encode("settlement");
export const CLAIM_SEED = new TextEncoder().encode("claim");
export const REFUND_SEED = new TextEncoder().encode("refund");

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


export function deriveSettlementPda(
  programId: PublicKey,
  contestPda: PublicKey,
  settlementVersion: number,
): PublicKey {
  const version = Buffer.alloc(4);
  version.writeUInt32LE(settlementVersion);
  return PublicKey.findProgramAddressSync(
    [SETTLEMENT_SEED, contestPda.toBuffer(), version],
    programId,
  )[0];
}

export function deriveClaimPda(
  programId: PublicKey,
  contestPda: PublicKey,
  settlementVersion: number,
  entryId: Uint8Array,
): PublicKey {
  const version = Buffer.alloc(4);
  version.writeUInt32LE(settlementVersion);
  return PublicKey.findProgramAddressSync(
    [CLAIM_SEED, contestPda.toBuffer(), version, Buffer.from(entryId)],
    programId,
  )[0];
}

export function deriveRefundPda(programId: PublicKey, contestPda: PublicKey, depositor: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [REFUND_SEED, contestPda.toBuffer(), depositor.toBuffer()],
    programId,
  )[0];
}

export function buildCommitSettlementInstruction(input: {
  programId: string;
  initAuthority: PublicKey;
  configPda: PublicKey;
  contestPda: PublicKey;
  settlementVersion: number;
  resultHash: Uint8Array;
  merkleRoot: Uint8Array;
  totalPayoutBaseUnits: number;
  feeBaseUnits: number;
}): TransactionInstruction {
  const programId = new PublicKey(input.programId);
  const settlement = deriveSettlementPda(programId, input.contestPda, input.settlementVersion);
  const data = new Uint8Array(8 + 4 + 32 + 32 + 8 + 8);
  data.set(anchorDiscriminator("commit_settlement"), 0);
  const view = new DataView(data.buffer);
  view.setUint32(8, input.settlementVersion, true);
  data.set(input.resultHash, 12);
  data.set(input.merkleRoot, 44);
  view.setBigUint64(76, BigInt(input.totalPayoutBaseUnits), true);
  view.setBigUint64(84, BigInt(input.feeBaseUnits), true);
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.initAuthority, isSigner: true, isWritable: true },
      { pubkey: input.configPda, isSigner: false, isWritable: false },
      { pubkey: input.contestPda, isSigner: false, isWritable: true },
      { pubkey: settlement, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}

export function buildClaimPayoutInstruction(input: {
  programId: string;
  claimant: PublicKey;
  contestPda: PublicKey;
  settlementVersion: number;
  entryId: string;
  amountBaseUnits: number;
  proof: Uint8Array[];
  mint: PublicKey;
  vault: PublicKey;
  claimantToken: PublicKey;
  tokenProgramId: PublicKey;
}): TransactionInstruction {
  const programId = new PublicKey(input.programId);
  const entryBytes = uuidToBytes(input.entryId);
  const settlement = deriveSettlementPda(programId, input.contestPda, input.settlementVersion);
  const claim = deriveClaimPda(programId, input.contestPda, input.settlementVersion, entryBytes);
  // discriminator + version + entry_id + amount + vec len + proofs
  const proofBytes = input.proof.length * 32;
  const data = new Uint8Array(8 + 4 + 16 + 8 + 4 + proofBytes);
  data.set(anchorDiscriminator("claim_payout"), 0);
  const view = new DataView(data.buffer);
  view.setUint32(8, input.settlementVersion, true);
  data.set(entryBytes, 12);
  view.setBigUint64(28, BigInt(input.amountBaseUnits), true);
  view.setUint32(36, input.proof.length, true);
  let offset = 40;
  for (const node of input.proof) {
    data.set(node, offset);
    offset += 32;
  }
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: input.claimant, isSigner: true, isWritable: true },
      { pubkey: input.contestPda, isSigner: false, isWritable: true },
      { pubkey: settlement, isSigner: false, isWritable: false },
      { pubkey: claim, isSigner: false, isWritable: true },
      { pubkey: input.mint, isSigner: false, isWritable: false },
      { pubkey: input.vault, isSigner: false, isWritable: true },
      { pubkey: input.claimantToken, isSigner: false, isWritable: true },
      { pubkey: input.tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}


export interface ClaimPlan {
  cluster: string;
  programId: string;
  contestId: string;
  settlementId: string;
  settlementVersion: number;
  entryId: string;
  amountBaseUnits: number;
  destinationWallet: string;
  mint: string;
  decimals: number;
  tokenProgramId: string;
  contestPda: string;
  vault: string;
  settlementPda: string;
  claimPda: string;
  claimantToken: string;
  merkleRoot: string;
  resultHash: string;
  proof: string[];
  claimStatus: string;
  claimSignature: string | null;
}

/** Authorized claim material derived only from approved settlement + escrow config. Never trust client amounts. */
export function buildClaimPlan(input: {
  config: EscrowClientConfig;
  contestId: string;
  settlementId: string;
  settlementVersion: number;
  entryId: string;
  amountBaseUnits: number;
  destinationWallet: string;
  merkleRoot: string;
  resultHash: string;
  proof: string[];
  claimStatus: string;
  claimSignature: string | null;
}): ClaimPlan {
  if (!input.config.usdcMint) {
    throw new Error("USDC mint is not configured");
  }
  if (!Number.isInteger(input.amountBaseUnits) || input.amountBaseUnits <= 0) {
    throw new Error("Claim amount must be a positive integer base units");
  }
  const programId = new PublicKey(input.config.programId);
  const mint = new PublicKey(input.config.usdcMint);
  const wallet = new PublicKey(input.destinationWallet);
  const tokenProgramId = new PublicKey(input.config.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58());
  const contestPda = deriveContestPda(programId, uuidToBytes(input.contestId));
  const vault = deriveVaultAddress(mint, contestPda, tokenProgramId);
  const settlementPda = deriveSettlementPda(programId, contestPda, input.settlementVersion);
  const claimPda = deriveClaimPda(programId, contestPda, input.settlementVersion, uuidToBytes(input.entryId));
  const claimantToken = getAssociatedTokenAddressSync(mint, wallet, false, tokenProgramId);
  return {
    cluster: input.config.cluster,
    programId: programId.toBase58(),
    contestId: input.contestId,
    settlementId: input.settlementId,
    settlementVersion: input.settlementVersion,
    entryId: input.entryId,
    amountBaseUnits: input.amountBaseUnits,
    destinationWallet: wallet.toBase58(),
    mint: mint.toBase58(),
    decimals: input.config.usdcDecimals,
    tokenProgramId: tokenProgramId.toBase58(),
    contestPda: contestPda.toBase58(),
    vault: vault.toBase58(),
    settlementPda: settlementPda.toBase58(),
    claimPda: claimPda.toBase58(),
    claimantToken: claimantToken.toBase58(),
    merkleRoot: input.merkleRoot,
    resultHash: input.resultHash,
    proof: [...input.proof],
    claimStatus: input.claimStatus,
    claimSignature: input.claimSignature,
  };
}

export function buildClaimPayoutTransaction(input: {
  plan: ClaimPlan;
  feePayer: PublicKey;
  recentBlockhash: string;
}): Transaction {
  if (input.feePayer.toBase58() !== input.plan.destinationWallet) {
    throw new Error("Fee payer must equal authorized claimant destination");
  }
  const proof = input.plan.proof.map((hex) => {
    const clean = hex.replace(/^0x/i, "");
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new Error("Invalid merkle proof node");
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 32; i += 1) {
      out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  });
  const ix = buildClaimPayoutInstruction({
    programId: input.plan.programId,
    claimant: input.feePayer,
    contestPda: new PublicKey(input.plan.contestPda),
    settlementVersion: input.plan.settlementVersion,
    entryId: input.plan.entryId,
    amountBaseUnits: input.plan.amountBaseUnits,
    proof,
    mint: new PublicKey(input.plan.mint),
    vault: new PublicKey(input.plan.vault),
    claimantToken: new PublicKey(input.plan.claimantToken),
    tokenProgramId: new PublicKey(input.plan.tokenProgramId),
  });
  const tx = new Transaction({
    feePayer: input.feePayer,
    recentBlockhash: input.recentBlockhash,
  });
  tx.add(ix);
  return tx;
}
