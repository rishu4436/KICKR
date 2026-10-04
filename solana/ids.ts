/** Public program id from declare_id. Not a mint and not a secret. */
export const DEFAULT_ESCROW_PROGRAM_ID = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";

export const ALLOWED_CLUSTERS = ["devnet", "localnet", "localhost", "testnet"] as const;

export function assertDevCluster(cluster: string): void {
  const normalized = cluster.toLowerCase();
  if (normalized === "mainnet" || normalized === "mainnet-beta" || normalized.includes("mainnet")) {
    throw new Error("KICKR escrow refuses mainnet. Devnet, localnet, or testnet only.");
  }
  if (!ALLOWED_CLUSTERS.includes(normalized as (typeof ALLOWED_CLUSTERS)[number])) {
    throw new Error(`Unsupported Solana cluster: ${cluster}`);
  }
}

/** Circle mainnet USDC. Refused even as a placeholder. Devnet mints are configured, never hardcoded to this. */
export const FORBIDDEN_MAINNET_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
