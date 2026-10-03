/**
 * Canonical login message. The client must sign these exact bytes.
 * The message binds nonce, domain, wallet, and expiry.
 */

export interface LoginMessageParts {
  domain: string;
  walletAddress: string;
  nonce: string;
  expiresAt: Date;
}

const PREFIX = "KICKR wants you to sign in with your Solana wallet.";

export function buildLoginMessage(parts: LoginMessageParts): string {
  return [
    PREFIX,
    `Domain: ${parts.domain}`,
    `Wallet: ${parts.walletAddress}`,
    `Nonce: ${parts.nonce}`,
    `Expires: ${parts.expiresAt.toISOString()}`,
  ].join("\n");
}

const MESSAGE_PATTERN =
  /^KICKR wants you to sign in with your Solana wallet\.\nDomain: ([^\n]+)\nWallet: ([^\n]+)\nNonce: ([^\n]+)\nExpires: ([^\n]+)$/;

export function parseLoginMessage(message: string): LoginMessageParts | null {
  if (message.length > 2048) {
    return null;
  }
  const match = MESSAGE_PATTERN.exec(message);
  if (!match) {
    return null;
  }
  const domain = match[1];
  const walletAddress = match[2];
  const nonce = match[3];
  const expiresRaw = match[4];
  if (!domain || !walletAddress || !nonce || !expiresRaw) {
    return null;
  }
  const expiresAt = new Date(expiresRaw);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.toISOString() !== expiresRaw) {
    return null;
  }
  return { domain, walletAddress, nonce, expiresAt };
}
