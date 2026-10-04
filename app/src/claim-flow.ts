/**
 * Phase 6.1.1 claim wallet helpers.
 * Builds claim_payout only from authorized ClaimPlan. No private keys here.
 * Mock providers are for UNIT TEST only (labelled).
 */
import { Connection } from "@solana/web3.js";
import type { PublicKey, Transaction, Signer } from "@solana/web3.js";
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
  | "cluster_mismatch";

export interface WalletAdapter {
  publicKey: PublicKey | null;
  connect(): Promise<PublicKey>;
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

export function assertClaimPlanIntegrity(plan: ClaimPlan, connectedWallet: string): void {
  if (plan.destinationWallet !== connectedWallet) {
    throw new Error("Connected wallet does not match authorized claimant");
  }
  if (!Number.isInteger(plan.amountBaseUnits) || plan.amountBaseUnits <= 0) {
    throw new Error("Authorized claim amount invalid");
  }
  if (!plan.proof.length && plan.amountBaseUnits > 0) {
    // Single-leaf trees may have empty proof; allow empty proof array.
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
 */
export async function signAndSubmitClaim(input: {
  plan: ClaimPlan;
  wallet: WalletAdapter;
  rpcUrl: string;
  appCluster: string;
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
    explorerUrl: null, // Explorer only after verified reconcile
    note: "Submitted is not claimed. Confirming independently.",
  };
}

/** UNIT TEST mock wallet — labelled test helper, not a browser Phantom. */
export function createMockWalletAdapter(input: {
  keypair: { publicKey: PublicKey; secretKey: Uint8Array };
  cluster?: string;
}): WalletAdapter & { lastSigned: Transaction | null } {
  const adapter: WalletAdapter & { lastSigned: Transaction | null } = {
    publicKey: input.keypair.publicKey,
    cluster: input.cluster ?? "devnet",
    lastSigned: null,
    async connect() {
      return input.keypair.publicKey;
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
};

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
    async signTransaction(tx: Transaction) {
      return provider.signTransaction(tx);
    },
  };
}
