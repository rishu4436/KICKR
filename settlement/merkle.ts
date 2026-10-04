import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { uuidToBytes } from "../solana/escrow.js";

const LEAF_PREFIX = Buffer.from("KICKR_PAYOUT_V1");

export function payoutLeaf(entryId: string, amountBaseUnits: number, claimant: string): Uint8Array {
  const entry = Buffer.from(uuidToBytes(entryId));
  const amount = Buffer.alloc(8);
  amount.writeBigUInt64LE(BigInt(amountBaseUnits));
  const wallet = Buffer.from(new PublicKey(claimant).toBytes());
  return createHash("sha256")
    .update(LEAF_PREFIX)
    .update(entry)
    .update(amount)
    .update(wallet)
    .digest();
}

function parent(a: Uint8Array, b: Uint8Array): Uint8Array {
  const left = Buffer.compare(a, b) <= 0 ? a : b;
  const right = Buffer.compare(a, b) <= 0 ? b : a;
  return createHash("sha256").update(left).update(right).digest();
}

export interface MerkleTree {
  root: Uint8Array;
  leaves: Uint8Array[];
  /** proof[i] = sibling hashes from leaf i to root */
  proofs: Uint8Array[][];
}

export function buildMerkleTree(leaves: Uint8Array[]): MerkleTree {
  if (leaves.length === 0) {
    const empty = createHash("sha256").update("KICKR_EMPTY_ROOT").digest();
    return { root: empty, leaves: [], proofs: [] };
  }
  const layers: Uint8Array[][] = [leaves.map((leaf) => Uint8Array.from(leaf))];
  while (layers[layers.length - 1]!.length > 1) {
    const current = layers[layers.length - 1]!;
    const next: Uint8Array[] = [];
    for (let i = 0; i < current.length; i += 2) {
      if (i + 1 < current.length) {
        next.push(parent(current[i]!, current[i + 1]!));
      } else {
        // Odd leaf promotes unchanged (paired with itself conceptually via duplicate)
        next.push(parent(current[i]!, current[i]!));
      }
    }
    layers.push(next);
  }
  const proofs: Uint8Array[][] = leaves.map((_, index) => {
    const proof: Uint8Array[] = [];
    let idx = index;
    for (let level = 0; level < layers.length - 1; level += 1) {
      const layer = layers[level]!;
      const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sibling < layer.length) {
        proof.push(layer[sibling]!);
      } else {
        proof.push(layer[idx]!);
      }
      idx = Math.floor(idx / 2);
    }
    return proof;
  });
  return {
    root: layers[layers.length - 1]![0]!,
    leaves: layers[0]!,
    proofs,
  };
}

export function verifyMerkleProof(leaf: Uint8Array, proof: Uint8Array[], root: Uint8Array): boolean {
  let current: Uint8Array = new Uint8Array(leaf);
  for (const sibling of proof) {
    current = parent(current, sibling);
  }
  return Buffer.compare(Buffer.from(current), Buffer.from(root)) === 0;
}

export function toHex32(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

export function fromHex32(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("expected 32-byte hex");
  }
  return Uint8Array.from(Buffer.from(hex, "hex"));
}
