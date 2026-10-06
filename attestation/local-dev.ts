import nacl from "tweetnacl";
import { AppError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { claimsFromAttestation, hashAttestationClaims } from "./canonical.js";
import { encodePublicKeyHex, encodeSignature } from "./verify.js";
import {
  ATTESTATION_VERSION,
  LOCAL_DEV_ATTESTOR_ID,
  type ResultAttestation,
  type ResultAttestationClaims,
} from "./types.js";

/**
 * LOCAL_DEV attestor helpers for tests and local development only.
 * Private keys never live in the repo. The backend must not sign in production.
 */
export function generateLocalDevAttestorKeypair(): {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyHex: string;
} {
  const pair = nacl.sign.keyPair();
  return {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    publicKeyHex: encodePublicKeyHex(pair.publicKey),
  };
}

export function signLocalDevAttestationClaims(
  claims: ResultAttestationClaims,
  secretKey: Uint8Array,
  nodeEnv: "development" | "test" | "production",
): string {
  if (nodeEnv === "production") {
    throw new AppError(
      "LOCAL_DEV_ATTESTOR_FORBIDDEN",
      403,
      "LOCAL_DEV attestor must never sign in production",
    );
  }
  if (claims.attestorId !== LOCAL_DEV_ATTESTOR_ID) {
    throw new AppError("VALIDATION", 400, "LOCAL_DEV signer requires attestorId=LOCAL_DEV");
  }
  const message = new TextEncoder().encode(hashAttestationClaims(claims));
  return encodeSignature(nacl.sign.detached(message, secretKey));
}

export function issueLocalDevAttestation(input: {
  matchId: string;
  contestId: string;
  scoringRulesetId: string;
  scoringRulesetVersion: number;
  providerSource?: string;
  finalizedSnapshotHash: string;
  resultHash: string;
  issuedAt: string;
  secretKey: Uint8Array;
  nodeEnv: "development" | "test" | "production";
  attestationId?: string;
}): ResultAttestation {
  const claims: ResultAttestationClaims = {
    version: ATTESTATION_VERSION,
    attestationId: input.attestationId ?? newId(),
    matchId: input.matchId,
    contestId: input.contestId,
    scoringRulesetId: input.scoringRulesetId,
    scoringRulesetVersion: input.scoringRulesetVersion,
    providerSource: input.providerSource ?? "local-dev",
    finalizedSnapshotHash: input.finalizedSnapshotHash,
    resultHash: input.resultHash,
    issuedAt: input.issuedAt,
    attestorId: LOCAL_DEV_ATTESTOR_ID,
  };
  const signature = signLocalDevAttestationClaims(claims, input.secretKey, input.nodeEnv);
  const now = input.issuedAt;
  return {
    ...claimsFromAttestation(claims),
    signature,
    verificationStatus: "PENDING",
    boundSettlementId: null,
    createdAt: now,
    updatedAt: now,
  };
}
