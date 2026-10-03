import bs58 from "bs58";
import nacl from "tweetnacl";

/**
 * Verify a detached ed25519 signature over the exact login message bytes.
 * The public key is the wallet address. Private keys are never stored or accepted.
 */
export function verifyWalletSignature(
  walletAddress: string,
  message: string,
  signature: string,
): boolean {
  let publicKey: Uint8Array;
  let sig: Uint8Array;
  try {
    publicKey = bs58.decode(walletAddress);
    sig = bs58.decode(signature);
  } catch {
    return false;
  }
  if (publicKey.length !== 32 || sig.length !== 64) {
    return false;
  }
  return nacl.sign.detached.verify(new TextEncoder().encode(message), sig, publicKey);
}
