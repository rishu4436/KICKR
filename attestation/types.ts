/**
 * Provider-neutral independent result attestation (Phase 9).
 * Sportmonks (and other feeds) do not sign results unless their real API does —
 * this model never claims they do.
 */

export const ATTESTATION_DOMAIN = "KICKR_RESULT_ATTESTATION_V1";
export const ATTESTATION_VERSION = 1 as const;
export const LOCAL_DEV_ATTESTOR_ID = "LOCAL_DEV";

export type AttestationVerificationStatus =
  | "PENDING"
  | "VERIFIED"
  | "INVALID"
  | "STALE"
  | "MISSING";

/** Ops-facing computed status. Never operator-set. */
export type OpsAttestationStatus = "Verified" | "Missing" | "Invalid" | "Stale";

/**
 * Signed claim fields (canonical payload excludes signature + verificationStatus).
 */
export interface ResultAttestationClaims {
  version: typeof ATTESTATION_VERSION;
  attestationId: string;
  matchId: string;
  contestId: string;
  scoringRulesetId: string;
  scoringRulesetVersion: number;
  providerSource: string;
  finalizedSnapshotHash: string;
  resultHash: string;
  issuedAt: string;
  attestorId: string;
}

export interface ResultAttestation extends ResultAttestationClaims {
  signature: string;
  verificationStatus: AttestationVerificationStatus;
  /** Set when the gate accepts this attestation for a settlement; blocks cross-contest reuse. */
  boundSettlementId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttestationStore {
  insert(row: ResultAttestation): Promise<void>;
  update(row: ResultAttestation): Promise<void>;
  getById(attestationId: string): Promise<ResultAttestation | null>;
  findForContestResult(contestId: string, resultHash: string): Promise<ResultAttestation | null>;
  listForContest(contestId: string): Promise<ResultAttestation[]>;
}

export interface ApprovedAttestor {
  id: string;
  publicKey: Uint8Array;
  /** True only for the LOCAL_DEV test/dev attestor. */
  localDevOnly: boolean;
}

export interface AttestorRegistry {
  list(): readonly ApprovedAttestor[];
  get(id: string): ApprovedAttestor | null;
  /** Production fails closed when empty (after filtering LOCAL_DEV). */
  isEmpty(): boolean;
}
