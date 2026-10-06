import bs58 from "bs58";
import nacl from "tweetnacl";
import { AppError } from "../shared/errors.js";
import { claimsFromAttestation, hashAttestationClaims } from "./canonical.js";
import {
  LOCAL_DEV_ATTESTOR_ID,
  type AttestorRegistry,
  type ResultAttestationClaims,
} from "./types.js";

export interface AttestorVerifier {
  /**
   * Cryptographic check only: signature against an approved attestor for the env.
   * Does not check contest/snapshot/result binding — that is the settlement gate.
   */
  verifySignature(
    attestation: ResultAttestationClaims & { signature: string },
  ): { ok: true; attestorId: string } | { ok: false; code: string; message: string };
}

export function createAttestorVerifier(
  registry: AttestorRegistry,
  nodeEnv: "development" | "test" | "production",
): AttestorVerifier {
  return {
    verifySignature(attestation) {
      if (registry.isEmpty()) {
        return {
          ok: false,
          code: "ATTESTOR_REGISTRY_EMPTY",
          message: "No approved attestors configured; attestation verification fails closed",
        };
      }
      if (attestation.attestorId === LOCAL_DEV_ATTESTOR_ID && nodeEnv === "production") {
        return {
          ok: false,
          code: "LOCAL_DEV_ATTESTOR_FORBIDDEN",
          message: "LOCAL_DEV attestor is never accepted in production",
        };
      }
      const attestor = registry.get(attestation.attestorId);
      if (!attestor) {
        return {
          ok: false,
          code: "ATTESTOR_UNAPPROVED",
          message: `Attestor ${attestation.attestorId} is not in the approved registry`,
        };
      }
      if (attestor.localDevOnly && nodeEnv === "production") {
        return {
          ok: false,
          code: "LOCAL_DEV_ATTESTOR_FORBIDDEN",
          message: "LOCAL_DEV attestor is never accepted in production",
        };
      }
      let signature: Uint8Array;
      try {
        signature = decodeSignature(attestation.signature);
      } catch {
        return { ok: false, code: "ATTESTATION_SIGNATURE_INVALID", message: "Attestation signature encoding is invalid" };
      }
      const message = new TextEncoder().encode(hashAttestationClaims(claimsFromAttestation(attestation)));
      const ok = nacl.sign.detached.verify(message, signature, attestor.publicKey);
      if (!ok) {
        return {
          ok: false,
          code: "ATTESTATION_SIGNATURE_INVALID",
          message: "Attestation signature does not verify against the approved attestor key",
        };
      }
      return { ok: true, attestorId: attestor.id };
    },
  };
}

function decodeSignature(raw: string): Uint8Array {
  if (/^[0-9a-fA-F]{128}$/.test(raw)) {
    const bytes = Buffer.from(raw, "hex");
    if (bytes.length !== 64) {
      throw new Error("bad sig length");
    }
    return new Uint8Array(bytes);
  }
  const bytes = bs58.decode(raw);
  if (bytes.length !== 64) {
    throw new Error("bad sig length");
  }
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Encode a detached Ed25519 signature as base58 (preferred wire form). */
export function encodeSignature(signature: Uint8Array): string {
  return bs58.encode(signature);
}

export function assertSignatureOrThrow(
  verifier: AttestorVerifier,
  attestation: ResultAttestationClaims & { signature: string },
): void {
  const result = verifier.verifySignature(attestation);
  if (!result.ok) {
    throw new AppError(result.code, 409, result.message);
  }
}

export function encodePublicKeyHex(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex");
}
