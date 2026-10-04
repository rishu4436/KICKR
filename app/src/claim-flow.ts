/**
 * Phase 6.1.1 / 6.1.2 claim + browser wallet helpers.
 * Builds claim_payout only from authorized ClaimPlan. No private keys here.
 * Mock providers are for UNIT TEST only (labelled).
 */
import { Connection } from "@solana/web3.js";
import type { PublicKey, Transaction, Signer } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";
import { buildClaimPayoutTransaction, type ClaimPlan } from "../../solana/escrow.js";
import { assertDevCluster } from "../../solana/ids.js";

export type ClaimUiState =
  | "idle"
  | "claimable"
  | "wallet_signing"
  | "submitted"
  | "confirming"
  | "confirmed"
  | "failed"
  | "already_claimed"
  | "cluster_mismatch"
  | "wallet_mismatch";

export interface WalletAdapter {
  publicKey: PublicKey | null;
  connect(): Promise<PublicKey>;
  signMessage(message: string): Promise<string>;
  signTransaction(tx: Transaction): Promise<Transaction>;
  /** Optional cluster/network label from the wallet (e.g. "devnet"). */
  cluster?: string | null;
}

export interface ClaimFlowResult {
  uiState: ClaimUiState;
  signature: string | null;
  explorerUrl: string | null;
  note: string;
}

export function explorerClaimUrl(signature: string | null, cluster: string): string | null {
  if (!signature) return null;
  const q = cluster === "devnet" || cluster === "testnet" ? `?cluster=${cluster}` : "";
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${q}`;
}

export function shortWallet(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

/**
 * Invariant: authenticated principal == entry destination == connected browser wallet.
 */
export function assertWalletClaimInvariant(input: {
  principalWallet: string;
  connectedWallet: string;
  destinationWallet: string;
}): void {
  if (input.principalWallet !== input.connectedWallet) {
    throw new Error("wallet_mismatch: authenticated principal does not match connected browser wallet");
  }
  if (input.principalWallet !== input.destinationWallet) {
    throw new Error("wallet_mismatch: authenticated principal does not match authorized claim destination");
  }
  if (input.connectedWallet !== input.destinationWallet) {
    throw new Error("wallet_mismatch: connected wallet does not match authorized claim destination");
  }
}

export function assertClaimPlanIntegrity(plan: ClaimPlan, connectedWallet: string): void {
  if (plan.destinationWallet !== connectedWallet) {
    throw new Error("Connected wallet does not match authorized claimant");
  }
  if (!Number.isInteger(plan.amountBaseUnits) || plan.amountBaseUnits <= 0) {
    throw new Error("Authorized claim amount invalid");
  }
  if (!plan.contestPda || !plan.vault || !plan.claimPda || !plan.mint || !plan.merkleRoot) {
    throw new Error("Authorized claim plan incomplete");
  }
}

export function checkClusterMatch(planCluster: string, walletCluster: string | null | undefined, appCluster: string): ClaimUiState | null {
  assertDevCluster(planCluster);
  assertDevCluster(appCluster);
  if (planCluster !== appCluster) {
    return "cluster_mismatch";
  }
  if (walletCluster && walletCluster !== planCluster) {
    return "cluster_mismatch";
  }
  return null;
}

/**
 * Sign and send claim_payout using only the authorized plan fields.
 * Does not mark claimed — caller must submit signature then reconcile.
 * Fee payer / claimant must equal authenticated principal and plan destination.
 */
export async function signAndSubmitClaim(input: {
  plan: ClaimPlan;
  wallet: WalletAdapter;
  rpcUrl: string;
  appCluster: string;
  principalWallet: string;
}): Promise<ClaimFlowResult> {
  const mismatch = checkClusterMatch(input.plan.cluster, input.wallet.cluster, input.appCluster);
  if (mismatch) {
    return {
      uiState: "cluster_mismatch",
      signature: null,
      explorerUrl: null,
      note: `Cluster mismatch: plan=${input.plan.cluster} app=${input.appCluster} wallet=${input.wallet.cluster ?? "unknown"}. Not signing.`,
    };
  }
  if (input.plan.claimStatus === "CLAIMED") {
    return {
      uiState: "already_claimed",
      signature: input.plan.claimSignature,
      explorerUrl: explorerClaimUrl(input.plan.claimSignature, input.plan.cluster),
      note: "Already claimed — detected before submit.",
    };
  }

  let pubkey = input.wallet.publicKey;
  if (!pubkey) {
    pubkey = await input.wallet.connect();
  }
  try {
    assertWalletClaimInvariant({
      principalWallet: input.principalWallet,
      connectedWallet: pubkey.toBase58(),
      destinationWallet: input.plan.destinationWallet,
    });
  } catch (error) {
    return {
      uiState: "wallet_mismatch",
      signature: null,
      explorerUrl: null,
      note: error instanceof Error ? error.message : "wallet_mismatch",
    };
  }
  assertClaimPlanIntegrity(input.plan, pubkey.toBase58());

  const connection = new Connection(input.rpcUrl, "confirmed");
  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = buildClaimPayoutTransaction({
    plan: input.plan,
    feePayer: pubkey,
    recentBlockhash: latest.blockhash,
  });
  const signed = await input.wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  return {
    uiState: "submitted",
    signature,
    explorerUrl: null,
    note: "Submitted is not claimed. Confirming independently.",
  };
}

/** UNIT TEST mock wallet — labelled test helper, not a browser Phantom. */
export function createMockWalletAdapter(input: {
  keypair: { publicKey: PublicKey; secretKey: Uint8Array };
  cluster?: string;
  /** Optional override for message signing (UNIT TEST). */
  signMessageFn?: (message: string) => Promise<string>;
}): WalletAdapter & { lastSigned: Transaction | null; lastMessage: string | null } {
  const naclSign = async (message: string): Promise<string> => {
    if (input.signMessageFn) return input.signMessageFn(message);
    const sig = nacl.sign.detached(new TextEncoder().encode(message), input.keypair.secretKey);
    return bs58.encode(sig);
  };
  const adapter: WalletAdapter & { lastSigned: Transaction | null; lastMessage: string | null } = {
    publicKey: input.keypair.publicKey,
    cluster: input.cluster ?? "devnet",
    lastSigned: null,
    lastMessage: null,
    async connect() {
      return input.keypair.publicKey;
    },
    async signMessage(message: string) {
      adapter.lastMessage = message;
      return naclSign(message);
    },
    async signTransaction(tx: Transaction) {
      tx.partialSign(input.keypair as Signer);
      adapter.lastSigned = tx;
      return tx;
    },
  };
  return adapter;
}

export function publicRpcForCluster(cluster: string): string {
  if (cluster === "devnet") return "https://solana-devnet.api.onfinality.io/public";
  if (cluster === "testnet") return "https://api.testnet.solana.com";
  if (cluster === "localhost" || cluster === "localnet") return "http://127.0.0.1:8899";
  throw new Error("Unsupported cluster");
}

type BrowserSolana = {
  publicKey?: PublicKey;
  isPhantom?: boolean;
  connect: () => Promise<{ publicKey: PublicKey }>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signMessage?: (message: Uint8Array, display?: string) => Promise<{ signature: Uint8Array } | Uint8Array>;
};

function encodeSignMessageResult(result: { signature: Uint8Array } | Uint8Array): string {
  const bytes = result instanceof Uint8Array ? result : result.signature;
  return bs58.encode(bytes);
}

export function readBrowserWallet(): WalletAdapter | null {
  const g = globalThis as typeof globalThis & { window?: { solana?: BrowserSolana }; solana?: BrowserSolana };
  const provider = g.window?.solana ?? g.solana;
  if (!provider?.signTransaction) {
    return null;
  }
  return {
    get publicKey() {
      return provider.publicKey ?? null;
    },
    cluster: null,
    async connect() {
      const res = await provider.connect();
      return res.publicKey;
    },
    async signMessage(message: string) {
      if (!provider.signMessage) {
        throw new Error("Browser wallet does not support signMessage");
      }
      const encoded = new TextEncoder().encode(message);
      const result = await provider.signMessage(encoded, "utf8");
      return encodeSignMessageResult(result);
    },
    async signTransaction(tx: Transaction) {
      return provider.signTransaction(tx);
    },
  };
}

/**
 * Login via existing /v1/auth/nonce + /v1/auth/login using a connected browser wallet.
 * Does not invent a second auth protocol. Requires a wallet signature over the issued message.
 */
export async function loginWithBrowserWallet(input: {
  wallet: WalletAdapter;
  requestNonce: (walletAddress: string) => Promise<{ message: string }>;
  requestLogin: (body: { walletAddress: string; message: string; signature: string }) => Promise<{
    token: string;
    account: { walletAddress: string };
  }>;
}): Promise<{ token: string; walletAddress: string }> {
  let pubkey = input.wallet.publicKey;
  if (!pubkey) {
    pubkey = await input.wallet.connect();
  }
  const walletAddress = pubkey.toBase58();
  const nonce = await input.requestNonce(walletAddress);
  const signature = await input.wallet.signMessage(nonce.message);
  if (!signature) {
    throw new Error("Wallet signature required — unsigned login rejected");
  }
  const session = await input.requestLogin({
    walletAddress,
    message: nonce.message,
    signature,
  });
  if (session.account.walletAddress !== walletAddress) {
    throw new Error("Session wallet does not match connected wallet");
  }
  return { token: session.token, walletAddress };
}

