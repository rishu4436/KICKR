import type { AuditStore } from "../audit/types.js";
import type { SnapshotStore } from "../live/snapshot.js";
import type { SettlementRecord } from "../settlement/types.js";
import { AppError } from "../shared/errors.js";
import { hashFinalizedSnapshots } from "./canonical.js";
import type { AttestorVerifier } from "./verify.js";
import {
  LOCAL_DEV_ATTESTOR_ID,
  type AttestationStore,
  type AttestorRegistry,
  type OpsAttestationStatus,
  type ResultAttestation,
} from "./types.js";

export interface SettlementAttestationGate {
  /**
   * Fail-closed gate before RESULT_APPROVED / SETTLEMENT_PREPARED.
   * Requires FINAL scoring context via approved snapshots + matching attestation.
   */
  assertAllowsAdvancement(input: {
    settlement: SettlementRecord;
    purpose: "approve" | "prepare";
    actorAccountId?: string | null;
    actorWallet?: string | null;
    correlationId?: string | null;
    now: Date;
  }): Promise<ResultAttestation>;

  /** Read-only ops status. Always recomputed; never operator-set. */
  computeOpsStatus(
    contestId: string,
    resultHash: string | null,
  ): Promise<{
    status: OpsAttestationStatus;
    attestationId: string | null;
    attestorId: string | null;
    reason: string | null;
  }>;
}

export function createSettlementAttestationGate(deps: {
  store: AttestationStore;
  snapshots: SnapshotStore;
  verifier: AttestorVerifier;
  registry: AttestorRegistry;
  audit: AuditStore;
  nodeEnv: "development" | "test" | "production";
}): SettlementAttestationGate {
  async function auditReject(
    input: {
      settlement: SettlementRecord;
      purpose: "approve" | "prepare";
      actorAccountId?: string | null;
      actorWallet?: string | null;
      correlationId?: string | null;
      now: Date;
    },
    attestation: ResultAttestation | null,
    code: string,
    message: string,
  ): Promise<AppError> {
    if (attestation) {
      await deps.store.update({
        ...attestation,
        verificationStatus: code === "ATTESTATION_STALE" ? "STALE" : "INVALID",
        updatedAt: input.now.toISOString(),
      });
    }
    await deps.audit.append({
      action: "ATTESTATION_REJECTED",
      occurredAt: input.now,
      entityType: "ATTESTATION",
      entityId: attestation?.attestationId ?? input.settlement.id,
      metadata: {
        result: "rejected",
        purpose: input.purpose,
        code,
        message,
        contestId: input.settlement.contestId,
        matchId: input.settlement.matchId,
        settlementId: input.settlement.id,
        resultHash: input.settlement.resultHash,
        attestorId: attestation?.attestorId ?? null,
      },
      actorAccountId: input.actorAccountId ?? null,
      actorWallet: input.actorWallet ?? null,
      correlationId: input.correlationId ?? null,
    });
    return new AppError(code, 409, message);
  }

  return {
    async assertAllowsAdvancement(input) {
      const { settlement, now } = input;

      if (deps.registry.isEmpty()) {
        throw await auditReject(
          input,
          null,
          "ATTESTOR_REGISTRY_EMPTY",
          "No approved attestors configured; settlement attestation fails closed",
        );
      }
      if (deps.nodeEnv === "production") {
        const usable = deps.registry.list().filter((row) => !row.localDevOnly);
        if (usable.length === 0) {
          throw await auditReject(
            input,
            null,
            "ATTESTOR_REGISTRY_EMPTY",
            "Production has no approved non-LOCAL_DEV attestor",
          );
        }
      }

      const approved = await deps.snapshots.listApprovedForContest(settlement.contestId);
      if (approved.length === 0) {
        throw await auditReject(
          input,
          null,
          "SNAPSHOT_MISSING",
          "No APPROVED score snapshots for attestation binding",
        );
      }
      for (const snap of approved) {
        if (snap.status !== "APPROVED" || !snap.approvedAt) {
          throw await auditReject(
            input,
            null,
            "SNAPSHOT_UNAPPROVED",
            "Settlement attestation requires FINAL APPROVED snapshots",
          );
        }
        if (snap.matchId !== settlement.matchId) {
          throw await auditReject(
            input,
            null,
            "SNAPSHOT_MATCH_MISMATCH",
            "Snapshot match_id does not match settlement",
          );
        }
        if (
          snap.dataFinalizationState !== "FINAL" &&
          snap.snapshot.dataFinalizationState !== "FINAL"
        ) {
          throw await auditReject(
            input,
            null,
            "MATCH_NOT_READY",
            "Scoring must be FINAL before attestation-gated settlement advancement",
          );
        }
      }

      const snapshotHash = hashFinalizedSnapshots(approved);
      const candidates = await deps.store.listForContest(settlement.contestId);
      const attestation =
        candidates.find((row) => row.resultHash === settlement.resultHash) ?? null;
      if (!attestation) {
        if (candidates.length > 0) {
          throw await auditReject(
            input,
            candidates[candidates.length - 1] ?? null,
            "ATTESTATION_RESULT_HASH_MISMATCH",
            "Attestation result hash does not match recomputed settlement result",
          );
        }
        throw await auditReject(
          input,
          null,
          "ATTESTATION_MISSING",
          "Required result attestation is missing",
        );
      }

      if (attestation.matchId !== settlement.matchId) {
        throw await auditReject(
          input,
          attestation,
          "ATTESTATION_MATCH_MISMATCH",
          "Attestation match_id does not match settlement",
        );
      }
      if (attestation.contestId !== settlement.contestId) {
        throw await auditReject(
          input,
          attestation,
          "ATTESTATION_CONTEST_MISMATCH",
          "Attestation contest_id does not match settlement",
        );
      }
      if (
        attestation.scoringRulesetId !== settlement.rulesetName ||
        attestation.scoringRulesetVersion !== settlement.rulesetVersion
      ) {
        throw await auditReject(
          input,
          attestation,
          "ATTESTATION_RULESET_MISMATCH",
          "Attestation scoring ruleset does not match settlement",
        );
      }
      if (attestation.resultHash !== settlement.resultHash) {
        throw await auditReject(
          input,
          attestation,
          "ATTESTATION_RESULT_HASH_MISMATCH",
          "Attestation result hash does not match recomputed settlement result",
        );
      }
      if (attestation.finalizedSnapshotHash !== snapshotHash) {
        throw await auditReject(
          input,
          attestation,
          "ATTESTATION_STALE",
          "Score snapshot changed after attestation (stale attestation)",
        );
      }
      if (attestation.boundSettlementId && attestation.boundSettlementId !== settlement.id) {
        throw await auditReject(
          input,
          attestation,
          "ATTESTATION_REPLAY",
          "Attestation was already bound to a different settlement (replay rejected)",
        );
      }

      const byId = await deps.store.getById(attestation.attestationId);
      if (byId && byId.contestId !== settlement.contestId) {
        throw await auditReject(
          input,
          attestation,
          "ATTESTATION_REPLAY",
          "Attestation id is bound to a different contest",
        );
      }

      if (attestation.attestorId === LOCAL_DEV_ATTESTOR_ID && deps.nodeEnv === "production") {
        throw await auditReject(
          input,
          attestation,
          "LOCAL_DEV_ATTESTOR_FORBIDDEN",
          "LOCAL_DEV attestor is never accepted in production",
        );
      }

      const sig = deps.verifier.verifySignature(attestation);
      if (!sig.ok) {
        throw await auditReject(input, attestation, sig.code, sig.message);
      }

      const accepted: ResultAttestation = {
        ...attestation,
        verificationStatus: "VERIFIED",
        boundSettlementId: settlement.id,
        updatedAt: now.toISOString(),
      };
      await deps.store.update(accepted);
      await deps.audit.append({
        action: "ATTESTATION_ACCEPTED",
        occurredAt: now,
        entityType: "ATTESTATION",
        entityId: attestation.attestationId,
        metadata: {
          result: "accepted",
          purpose: input.purpose,
          contestId: settlement.contestId,
          matchId: settlement.matchId,
          settlementId: settlement.id,
          resultHash: settlement.resultHash,
          snapshotHash,
          attestorId: attestation.attestorId,
        },
        actorAccountId: input.actorAccountId ?? null,
        actorWallet: input.actorWallet ?? null,
        correlationId: input.correlationId ?? null,
      });
      return accepted;
    },

    async computeOpsStatus(contestId, resultHash) {
      if (!resultHash) {
        return { status: "Missing", attestationId: null, attestorId: null, reason: "no_result_hash" };
      }
      if (deps.registry.isEmpty()) {
        return {
          status: "Invalid",
          attestationId: null,
          attestorId: null,
          reason: "attestor_registry_empty",
        };
      }
      const attestation = await deps.store.findForContestResult(contestId, resultHash);
      if (!attestation) {
        return { status: "Missing", attestationId: null, attestorId: null, reason: "missing" };
      }
      const approved = await deps.snapshots.listApprovedForContest(contestId);
      const snapshotHash = hashFinalizedSnapshots(approved);
      if (attestation.finalizedSnapshotHash !== snapshotHash) {
        return {
          status: "Stale",
          attestationId: attestation.attestationId,
          attestorId: attestation.attestorId,
          reason: "snapshot_changed",
        };
      }
      if (attestation.attestorId === LOCAL_DEV_ATTESTOR_ID && deps.nodeEnv === "production") {
        return {
          status: "Invalid",
          attestationId: attestation.attestationId,
          attestorId: attestation.attestorId,
          reason: "LOCAL_DEV_ATTESTOR_FORBIDDEN",
        };
      }
      const sig = deps.verifier.verifySignature(attestation);
      if (!sig.ok) {
        return {
          status: "Invalid",
          attestationId: attestation.attestationId,
          attestorId: attestation.attestorId,
          reason: sig.code,
        };
      }
      if (attestation.contestId !== contestId || attestation.resultHash !== resultHash) {
        return {
          status: "Invalid",
          attestationId: attestation.attestationId,
          attestorId: attestation.attestorId,
          reason: "binding_mismatch",
        };
      }
      return {
        status: "Verified",
        attestationId: attestation.attestationId,
        attestorId: attestation.attestorId,
        reason: null,
      };
    },
  };
}
