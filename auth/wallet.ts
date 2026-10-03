import bs58 from "bs58";
import { AppError } from "../shared/errors.js";

/** Canonical base58 Solana public key. Rejects anything that is not 32 bytes. */
export function canonicalizeWallet(wallet: string): string {
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(wallet);
  } catch {
    throw new AppError("VALIDATION", 400, "Invalid wallet address");
  }
  if (decoded.length !== 32) {
    throw new AppError("VALIDATION", 400, "Invalid wallet address");
  }
  return bs58.encode(decoded);
}
