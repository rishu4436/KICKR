import bs58 from "bs58";
import { ConfigError } from "../shared/errors.js";
import {
  LOCAL_DEV_ATTESTOR_ID,
  type ApprovedAttestor,
  type AttestorRegistry,
} from "./types.js";

/**
 * Parse APPROVED_ATTESTORS env.
 * Format: "ID:hexOrBs58Pubkey,ID2:hexOrBs58Pubkey"
 * LOCAL_DEV is allowed only outside production.
 */
export function parseApprovedAttestors(
  raw: string | null | undefined,
  nodeEnv: "development" | "test" | "production",
): ApprovedAttestor[] {
  const text = (raw ?? "").trim();
  if (!text) {
    return [];
  }
  const out: ApprovedAttestor[] = [];
  for (const part of text.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const colon = trimmed.indexOf(":");
    if (colon <= 0) {
      throw new ConfigError(`Invalid APPROVED_ATTESTORS entry: ${trimmed}`);
    }
    const id = trimmed.slice(0, colon).trim();
    const keyRaw = trimmed.slice(colon + 1).trim();
    if (!id || !keyRaw) {
      throw new ConfigError(`Invalid APPROVED_ATTESTORS entry: ${trimmed}`);
    }
    const publicKey = decodePublicKey(keyRaw);
    const localDevOnly = id === LOCAL_DEV_ATTESTOR_ID;
    if (localDevOnly && nodeEnv === "production") {
      throw new ConfigError("LOCAL_DEV attestor must never be configured in production");
    }
    out.push({ id, publicKey, localDevOnly });
  }
  return out;
}

function decodePublicKey(raw: string): Uint8Array {
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    const bytes = Buffer.from(raw, "hex");
    if (bytes.length !== 32) {
      throw new ConfigError("Attestor public key must be 32 bytes");
    }
    return new Uint8Array(bytes);
  }
  try {
    const bytes = bs58.decode(raw);
    if (bytes.length !== 32) {
      throw new ConfigError("Attestor public key must be 32 bytes");
    }
    return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("Attestor public key must be 32-byte hex or base58");
  }
}

export function createAttestorRegistry(attestors: readonly ApprovedAttestor[]): AttestorRegistry {
  const byId = new Map(attestors.map((row) => [row.id, row]));
  return {
    list: () => attestors,
    get: (id) => byId.get(id) ?? null,
    isEmpty: () => attestors.length === 0,
  };
}

export function assertProductionAttestorRegistry(
  registry: AttestorRegistry,
  nodeEnv: "development" | "test" | "production",
): void {
  if (nodeEnv !== "production") {
    return;
  }
  const usable = registry.list().filter((row) => !row.localDevOnly);
  if (usable.length === 0) {
    throw new ConfigError(
      "Production requires at least one approved non-LOCAL_DEV attestor (APPROVED_ATTESTORS)",
    );
  }
  if (registry.list().some((row) => row.localDevOnly)) {
    throw new ConfigError("LOCAL_DEV attestor must never be accepted in production");
  }
}
