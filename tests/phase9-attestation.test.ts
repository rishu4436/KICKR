import { describe, expect, it } from "vitest";
import nacl from "tweetnacl";
import { ConfigError } from "../shared/errors.js";
import {
  canonicalJson,
  claimsFromAttestation,
  hashAttestationClaims,
  hashFinalizedSnapshots,
} from "../attestation/canonical.js";
import {
  assertProductionAttestorRegistry,
  createAttestorRegistry,
  parseApprovedAttestors,
} from "../attestation/registry.js";
import { createAttestorVerifier, encodeSignature } from "../attestation/verify.js";
import {
  generateLocalDevAttestorKeypair,
  issueLocalDevAttestation,
} from "../attestation/local-dev.js";
import { InMemoryAttestationStore } from "../attestation/memory-store.js";
import { createSettlementAttestationGate } from "../attestation/gate.js";
import {
  ATTESTATION_VERSION,
  LOCAL_DEV_ATTESTOR_ID,
  type ResultAttestation,
} from "../attestation/types.js";
import {
  buildLocalDevAttestationWorld,
  issueAndStoreLocalDevAttestation,
  seedApprovedSnapshotsForSettlement,
} from "../attestation/test-harness.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";
import { loadConfig } from "../config/load.js";

const feePolicy = {
  id: "51000000-0000-4000-8000-000000000001",
  version: 1,
  rateBps: 1000,
  label: "DEV",
};
const h2hPolicy = {
  id: "52000000-0000-4000-8000-000000000001",
  version: 2,
  policyType: "HEAD_TO_HEAD" as const,
  configuration: {
    shape: "HEAD_TO_HEAD",
    calculation: "winner_takes_prize_pool",
    tiePolicy: "entry_id_asc",
  },
};

function ranked(id: string, score: number, wallet: string) {
  return {
    entryId: id,
    teamVersionId: "61000000-0000-4000-8000-000000000001",
    destinationWallet: wallet,
    finalScoreMilliPoints: score,
    baseScoreMilliPoints: score,
    xi: Array.from({ length: 11 }, (_, i) => `p${i}`),
    captainId: "p0",
    viceId: "p1",
  };
}

async function calculatedWorld() {
  const world = buildLocalDevAttestationWorld();
  const w1 = generateWallet().publicKey;
  const w2 = generateWallet().publicKey;
  const settlement = await world.settlements.calculate({
    contestId: "c0000000-0000-4000-8000-000000000901",
    matchId: "m0000000-0000-4000-8000-000000000901",
    matchSettlementGate: "FINAL",
    entryFeeBaseUnits: 5_000_000,
    seatCount: 2,
    contestRules: { frozen: true },
    rulesetName: "DEV_V1",
    rulesetVersion: 1,
    feePolicy,
    payoutPolicy: h2hPolicy,
    entries: [
      ranked("a0000000-0000-4000-8000-000000000001", 9000, w1),
      ranked("a0000000-0000-4000-8000-000000000002", 1000, w2),
    ],
    actorId: "actor",
    nowIso: "2026-10-06T12:00:00.000Z",
  });
  await world.settlements.review(settlement.id, "reviewer", "2026-10-06T12:01:00.000Z");
  const rows = await world.settlements.getLeaderboard(settlement.id);
  return { world, settlement, rows };
}

describe("Phase 9 independent result attestation", () => {
  it("canonical hash determinism", () => {
    const claims = {
      version: ATTESTATION_VERSION,
      attestationId: "a0000000-0000-4000-8000-000000000099",
      matchId: "m0000000-0000-4000-8000-000000000099",
      contestId: "c0000000-0000-4000-8000-000000000099",
      scoringRulesetId: "DEV_V1",
      scoringRulesetVersion: 1,
      providerSource: "local-dev",
      finalizedSnapshotHash: "ab".repeat(32),
      resultHash: "cd".repeat(32),
      issuedAt: "2026-10-06T12:00:00.000Z",
      attestorId: LOCAL_DEV_ATTESTOR_ID,
    };
    const a = hashAttestationClaims(claims);
    const b = hashAttestationClaims({ ...claims });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    const json = canonicalJson({ b: 1, a: 2 });
    expect(json).toBe('{"a":2,"b":1}');
    expect(hashFinalizedSnapshots([])).toBe(hashFinalizedSnapshots([]));
  });

  it("valid path accepts LOCAL_DEV attestation and allows approve/prepare", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await issueAndStoreLocalDevAttestation({
      world,
      settlement,
      rows,
      nowIso: "2026-10-06T12:01:30.000Z",
    });
    const approved = await world.settlements.approve(
      settlement.id,
      "reviewer",
      "2026-10-06T12:02:00.000Z",
    );
    expect(approved.status).toBe("SETTLEMENT_APPROVED");
    const prepared = await world.settlements.prepare(settlement.id, "2026-10-06T12:03:00.000Z");
    expect(prepared.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    const status = await world.gate.computeOpsStatus(settlement.contestId, settlement.resultHash);
    expect(status.status).toBe("Verified");
    const accepted = await world.audit.query({ limit: 20, action: "ATTESTATION_ACCEPTED" });
    expect(accepted.length).toBeGreaterThan(0);
  });

  it("forged signature fails closed", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    const attestation = await issueAndStoreLocalDevAttestation({
      world,
      settlement,
      rows,
      nowIso: "2026-10-06T12:01:30.000Z",
    });
    const forged: ResultAttestation = {
      ...attestation,
      signature: encodeSignature(nacl.sign.detached(new Uint8Array(32), world.keypair.secretKey)),
    };
    await world.attestations.update(forged);
    await expect(
      world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTATION_SIGNATURE_INVALID" });
  });

  it("wrong match fails closed", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await issueAndStoreLocalDevAttestation({
      world,
      settlement,
      rows,
      nowIso: "2026-10-06T12:01:30.000Z",
      overrides: { matchId: "m0000000-0000-4000-8000-000000000777" },
    });
    await expect(
      world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTATION_MATCH_MISMATCH" });
  });

  it("wrong contest fails closed", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await issueAndStoreLocalDevAttestation({
      world,
      settlement,
      rows,
      nowIso: "2026-10-06T12:01:30.000Z",
      overrides: { contestId: "c0000000-0000-4000-8000-000000000777" },
    });
    // Attestation stored under other contest id → missing for this settlement contest.
    await expect(
      world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTATION_MISSING" });
  });

  it("wrong result hash fails closed", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await issueAndStoreLocalDevAttestation({
      world,
      settlement,
      rows,
      nowIso: "2026-10-06T12:01:30.000Z",
      overrides: { resultHash: "ee".repeat(32) },
    });
    await expect(
      world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTATION_RESULT_HASH_MISMATCH" });
  });

  it("score changed after attestation is stale", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await issueAndStoreLocalDevAttestation({
      world,
      settlement,
      rows,
      nowIso: "2026-10-06T12:01:30.000Z",
    });
    // Mutate by inserting a new approved snapshot for another entry path — change hash by approving extra draft
    const extra = structuredClone(rows[0]!);
    extra.entryId = "a0000000-0000-4000-8000-000000000099";
    extra.teamVersionId = "61000000-0000-4000-8000-000000000099";
    await seedApprovedSnapshotsForSettlement(
      world.snapshots,
      { ...settlement, contestId: settlement.contestId },
      // seedApproved skips if any approved exist — so directly insert another
      [],
      "2026-10-06T12:01:45.000Z",
    );
    // Force stale: update attestation snapshot hash mismatch by replacing attestation with old hash after new snapshot
    const approved = await world.snapshots.listApprovedForContest(settlement.contestId);
    // Add another approved snapshot
    const { buildDraftSnapshot } = await import("../live/snapshot.js");
    const { newId } = await import("../shared/ids.js");
    const draft = buildDraftSnapshot({
      matchId: settlement.matchId,
      contestId: settlement.contestId,
      entryId: "a0000000-0000-4000-8000-000000000099",
      version: {
        id: "61000000-0000-4000-8000-000000000099",
        teamId: newId(),
        version: 1,
        matchId: settlement.matchId,
        playerIds: Array.from({ length: 11 }, (_, i) => `p${i}`),
        captainId: "p0",
        viceId: "p1",
        creditsUsed: 100,
        validationResult: { valid: true, errors: [] },
        createdAt: "2026-10-06T12:01:45.000Z",
      },
      finalScoreMilliPoints: 1,
      ranking: 3,
      playerScores: [],
      dataFinalizationState: "FINAL",
      nowIso: "2026-10-06T12:01:45.000Z",
    });
    await world.snapshots.insertDraft(draft);
    await world.snapshots.approve(draft.id, "2026-10-06T12:01:45.000Z");
    void approved;
    await expect(
      world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTATION_STALE" });
  });

  it("replayed attestation across settlements is rejected", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await issueAndStoreLocalDevAttestation({
      world,
      settlement,
      rows,
      nowIso: "2026-10-06T12:01:30.000Z",
    });
    await world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z");
    // Second settlement same contest after reject path — bind already set; craft another settlement id reuse
    const other = await world.settlements.calculate({
      contestId: "c0000000-0000-4000-8000-000000000902",
      matchId: "m0000000-0000-4000-8000-000000000902",
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: { frozen: true },
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: rows.map((row, index) => ({
        ...row,
        entryId: index === 0 ? "a0000000-0000-4000-8000-000000000011" : "a0000000-0000-4000-8000-000000000012",
        teamVersionId: index === 0 ? "61000000-0000-4000-8000-000000000011" : "61000000-0000-4000-8000-000000000012",
      })),
      actorId: "actor",
      nowIso: "2026-10-06T12:10:00.000Z",
    });
    await world.settlements.review(other.id, "reviewer", "2026-10-06T12:11:00.000Z");
    // Reuse same attestation id against other settlement by storing a copy with other contest but same id fails unique — 
    // instead mark bound and try approve again on a clone path: update attestation bound to first, then point find to it for other
    // Signature won't match mutated claims — use fresh signed attestation with same attestationId after deleting? 
    // Store path: insert new attestation signed for other, then force boundSettlementId to first settlement.
    const otherRows = await world.settlements.getLeaderboard(other.id);
    const second = await issueAndStoreLocalDevAttestation({
      world,
      settlement: other,
      rows: otherRows,
      nowIso: "2026-10-06T12:11:30.000Z",
    });
    await world.attestations.update({
      ...second,
      boundSettlementId: settlement.id,
      updatedAt: "2026-10-06T12:11:31.000Z",
    });
    await expect(
      world.settlements.approve(other.id, "reviewer", "2026-10-06T12:12:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTATION_REPLAY" });
  });

  it("unapproved attestor fails closed", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await seedApprovedSnapshotsForSettlement(world.snapshots, settlement, rows, "2026-10-06T12:01:30.000Z");
    const approved = await world.snapshots.listApprovedForContest(settlement.contestId);
    const stranger = generateLocalDevAttestorKeypair();
    const claims = {
      version: ATTESTATION_VERSION,
      attestationId: "a0000000-0000-4000-8000-000000000055",
      matchId: settlement.matchId,
      contestId: settlement.contestId,
      scoringRulesetId: settlement.rulesetName,
      scoringRulesetVersion: settlement.rulesetVersion,
      providerSource: "local-dev",
      finalizedSnapshotHash: hashFinalizedSnapshots(approved),
      resultHash: settlement.resultHash,
      issuedAt: "2026-10-06T12:01:30.000Z",
      attestorId: "STRANGER",
    };
    const message = new TextEncoder().encode(hashAttestationClaims(claims));
    const signature = encodeSignature(nacl.sign.detached(message, stranger.secretKey));
    await world.attestations.insert({
      ...claimsFromAttestation(claims),
      signature,
      verificationStatus: "PENDING",
      boundSettlementId: null,
      createdAt: claims.issuedAt,
      updatedAt: claims.issuedAt,
    });
    await expect(
      world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTOR_UNAPPROVED" });
  });

  it("LOCAL_DEV attestor is refused in production", async () => {
    const keypair = generateLocalDevAttestorKeypair();
    expect(() =>
      parseApprovedAttestors(`${LOCAL_DEV_ATTESTOR_ID}:${keypair.publicKeyHex}`, "production"),
    ).toThrow(ConfigError);

    const registry = createAttestorRegistry([
      { id: LOCAL_DEV_ATTESTOR_ID, publicKey: keypair.publicKey, localDevOnly: true },
    ]);
    const verifier = createAttestorVerifier(registry, "production");
    const claims = {
      version: ATTESTATION_VERSION,
      attestationId: "a0000000-0000-4000-8000-000000000066",
      matchId: "m0000000-0000-4000-8000-000000000066",
      contestId: "c0000000-0000-4000-8000-000000000066",
      scoringRulesetId: "DEV_V1",
      scoringRulesetVersion: 1,
      providerSource: "local-dev",
      finalizedSnapshotHash: "ab".repeat(32),
      resultHash: "cd".repeat(32),
      issuedAt: "2026-10-06T12:00:00.000Z",
      attestorId: LOCAL_DEV_ATTESTOR_ID,
    };
    const attestation = issueLocalDevAttestation({
      ...claims,
      secretKey: keypair.secretKey,
      nodeEnv: "test",
    });
    const result = verifier.verifySignature(attestation);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("LOCAL_DEV_ATTESTOR_FORBIDDEN");
    }
  });

  it("missing attestation fails closed", async () => {
    const { world, settlement, rows } = await calculatedWorld();
    await seedApprovedSnapshotsForSettlement(world.snapshots, settlement, rows, "2026-10-06T12:01:30.000Z");
    await expect(
      world.settlements.approve(settlement.id, "reviewer", "2026-10-06T12:02:00.000Z"),
    ).rejects.toMatchObject({ code: "ATTESTATION_MISSING" });
    const status = await world.gate.computeOpsStatus(settlement.contestId, settlement.resultHash);
    expect(status.status).toBe("Missing");
  });

  it("production with no approved attestor fails closed at config load", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: "postgres://kickr:x@localhost/kickr",
        REDIS_URL: "redis://localhost",
        AUTH_DOMAIN: "kickr.app",
        SOLANA_RPC_URL: "https://rpc.example",
        ESCROW_PROGRAM_ID: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN",
        USDC_MINT: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
        SPORTS_PROVIDER: "DEMO",
        SPORTS_DATA_PROVIDER: "unset",
        ALLOWED_ORIGINS: "https://kickr.app",
        SESSION_TTL_SECONDS: "3600",
        APPROVED_ATTESTORS: "",
      }),
    ).toThrow(/approved non-LOCAL_DEV attestor/i);
  });

  it("no ops override can mark an attestation valid", async () => {
    const NOW = new Date("2026-10-06T12:00:00.000Z");
    const built = buildTestApp(() => NOW);
    const wallet = generateWallet();
    const issued = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session = await built.deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    await built.grants.grantRole(session.account.id, "CEO_HEAD");
    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    };
    for (const path of [
      "/v1/ops/attestations/00000000-0000-4000-8000-000000000001/mark-valid",
      "/v1/ops/attestations/00000000-0000-4000-8000-000000000001/override",
      "/v1/ops/settlements/00000000-0000-4000-8000-000000000001/attestation/approve",
    ]) {
      const response = await built.app.request(path, {
        method: "POST",
        headers,
        body: JSON.stringify({ confirm: true }),
      });
      expect(response.status).toBe(403);
      const body = (await response.json()) as { error: { code: string } };
      expect(body.error.code).toBe("FUNDS_MOVEMENT_DENIED");
    }
    // Status remains verifier-computed Missing without an attestation
    const status = await built.attestationGate.computeOpsStatus(
      "c0000000-0000-4000-8000-000000000001",
      "ab".repeat(32),
    );
    expect(status.status).toBe("Missing");
  });

  it("empty registry fails closed at the gate", async () => {
    const audit = new InMemoryAuditStore();
    const snapshots = (await import("../live/snapshot.js")).InMemorySnapshotStore;
    const snapStore = new snapshots();
    const store = new InMemoryAttestationStore();
    const registry = createAttestorRegistry([]);
    const gate = createSettlementAttestationGate({
      store,
      snapshots: snapStore,
      verifier: createAttestorVerifier(registry, "test"),
      registry,
      audit,
      nodeEnv: "test",
    });
    await expect(
      gate.assertAllowsAdvancement({
        settlement: {
          id: "s0000000-0000-4000-8000-000000000001",
          contestId: "c0000000-0000-4000-8000-000000000001",
          matchId: "m0000000-0000-4000-8000-000000000001",
          settlementVersion: 1,
          status: "RESULT_REVIEWED",
          resultHash: "ab".repeat(32),
          merkleRoot: null,
          settlementHash: null,
          calculationVersion: 1,
          feePolicyId: feePolicy.id,
          feePolicyVersion: 1,
          feeRateBps: 1000,
          payoutPolicyId: h2hPolicy.id,
          payoutPolicyVersion: 2,
          payoutPolicyType: "HEAD_TO_HEAD",
          payoutConfiguration: h2hPolicy.configuration,
          rulesetName: "DEV_V1",
          rulesetVersion: 1,
          entryFeeBaseUnits: 5_000_000,
          seatCount: 2,
          confirmedEntries: 2,
          totalPotBaseUnits: 10_000_000,
          feeBaseUnits: 1_000_000,
          totalPayoutBaseUnits: 9_000_000,
          commitSignature: null,
          confirmedSlot: null,
          confirmedAt: null,
          failureReason: null,
          approvedBy: null,
          approvedAt: null,
          createdAt: "2026-10-06T12:00:00.000Z",
          updatedAt: "2026-10-06T12:00:00.000Z",
          payload: {} as never,
        },
        purpose: "approve",
        now: new Date("2026-10-06T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ code: "ATTESTOR_REGISTRY_EMPTY" });
    expect(() => assertProductionAttestorRegistry(registry, "production")).toThrow(ConfigError);
  });
});
