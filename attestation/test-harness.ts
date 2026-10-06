/**
 * Test/dev harness for LOCAL_DEV attestations. Not used in production.
 * Private keys stay in process memory for the test only — never committed.
 */
import type { AuditStore } from "../audit/types.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import {
  buildDraftSnapshot,
  InMemorySnapshotStore,
  type ResultSnapshotRecord,
  type SnapshotStore,
} from "../live/snapshot.js";
import type { FantasyTeamVersionRecord } from "../football/store.js";
import { SettlementService } from "../settlement/service.js";
import { InMemorySettlementStore } from "../settlement/memory-store.js";
import type { SettlementRecord, SettlementResultRow } from "../settlement/types.js";
import { newId } from "../shared/ids.js";
import { createSettlementAttestationGate, type SettlementAttestationGate } from "./gate.js";
import { hashFinalizedSnapshots } from "./canonical.js";
import { issueLocalDevAttestation, generateLocalDevAttestorKeypair } from "./local-dev.js";
import { InMemoryAttestationStore } from "./memory-store.js";
import { createAttestorRegistry } from "./registry.js";
import { createAttestorVerifier } from "./verify.js";
import { LOCAL_DEV_ATTESTOR_ID, type AttestationStore, type ResultAttestation } from "./types.js";

export interface LocalDevAttestationWorld {
  nodeEnv: "development" | "test";
  keypair: ReturnType<typeof generateLocalDevAttestorKeypair>;
  registry: ReturnType<typeof createAttestorRegistry>;
  verifier: ReturnType<typeof createAttestorVerifier>;
  attestations: AttestationStore;
  snapshots: SnapshotStore;
  audit: AuditStore;
  gate: SettlementAttestationGate;
  settlementStore: InMemorySettlementStore;
  settlements: SettlementService;
}

export function buildLocalDevAttestationWorld(
  nodeEnv: "development" | "test" = "test",
): LocalDevAttestationWorld {
  const keypair = generateLocalDevAttestorKeypair();
  const registry = createAttestorRegistry([
    { id: LOCAL_DEV_ATTESTOR_ID, publicKey: keypair.publicKey, localDevOnly: true },
  ]);
  const verifier = createAttestorVerifier(registry, nodeEnv);
  const attestations = new InMemoryAttestationStore();
  const snapshots = new InMemorySnapshotStore();
  const audit = new InMemoryAuditStore();
  const gate = createSettlementAttestationGate({
    store: attestations,
    snapshots,
    verifier,
    registry,
    audit,
    nodeEnv,
  });
  const settlementStore = new InMemorySettlementStore();
  const settlements = new SettlementService(settlementStore, gate);
  return {
    nodeEnv,
    keypair,
    registry,
    verifier,
    attestations,
    snapshots,
    audit,
    gate,
    settlementStore,
    settlements,
  };
}

/** Insert minimal FINAL APPROVED snapshots so the gate can bind a snapshot hash. */
export async function seedApprovedSnapshotsForSettlement(
  snapshots: SnapshotStore,
  settlement: SettlementRecord,
  rows: SettlementResultRow[],
  nowIso: string,
): Promise<ResultSnapshotRecord[]> {
  const existing = await snapshots.listApprovedForContest(settlement.contestId);
  if (existing.length > 0) {
    return existing;
  }
  const approved: ResultSnapshotRecord[] = [];
  for (const row of rows) {
    const version: FantasyTeamVersionRecord = {
      id: row.teamVersionId,
      teamId: newId(),
      version: 1,
      matchId: settlement.matchId,
      playerIds: [...row.xi],
      captainId: row.captainId,
      viceId: row.viceId,
      creditsUsed: 100,
      validationResult: { valid: true, errors: [] },
      createdAt: nowIso,
    };
    const draft = buildDraftSnapshot({
      matchId: settlement.matchId,
      contestId: settlement.contestId,
      entryId: row.entryId,
      version,
      finalScoreMilliPoints: row.finalScoreMilliPoints,
      ranking: row.rank,
      playerScores: row.xi.map((playerId, index) => ({
        playerId,
        baseMilliPoints: index === 0 ? row.baseScoreMilliPoints : 0,
        milliPoints: index === 0 ? row.finalScoreMilliPoints : 0,
        role: playerId === row.captainId ? "captain" : playerId === row.viceId ? "vice" : "player",
      })),
      dataFinalizationState: "FINAL",
      nowIso,
    });
    await snapshots.insertDraft(draft);
    approved.push(await snapshots.approve(draft.id, nowIso));
  }
  return approved;
}

export async function issueAndStoreLocalDevAttestation(input: {
  world: Pick<LocalDevAttestationWorld, "attestations" | "snapshots" | "keypair" | "nodeEnv">;
  settlement: SettlementRecord;
  rows: SettlementResultRow[];
  nowIso: string;
  overrides?: Partial<{
    matchId: string;
    contestId: string;
    resultHash: string;
    finalizedSnapshotHash: string;
    scoringRulesetId: string;
    scoringRulesetVersion: number;
    attestationId: string;
  }>;
}): Promise<ResultAttestation> {
  const approved = await seedApprovedSnapshotsForSettlement(
    input.world.snapshots,
    input.settlement,
    input.rows,
    input.nowIso,
  );
  const snapshotHash = hashFinalizedSnapshots(approved);
  const attestation = issueLocalDevAttestation({
    matchId: input.overrides?.matchId ?? input.settlement.matchId,
    contestId: input.overrides?.contestId ?? input.settlement.contestId,
    scoringRulesetId: input.overrides?.scoringRulesetId ?? input.settlement.rulesetName,
    scoringRulesetVersion: input.overrides?.scoringRulesetVersion ?? input.settlement.rulesetVersion,
    finalizedSnapshotHash: input.overrides?.finalizedSnapshotHash ?? snapshotHash,
    resultHash: input.overrides?.resultHash ?? input.settlement.resultHash,
    issuedAt: input.nowIso,
    secretKey: input.world.keypair.secretKey,
    nodeEnv: input.world.nodeEnv,
    attestationId: input.overrides?.attestationId,
  });
  await input.world.attestations.insert(attestation);
  return attestation;
}
