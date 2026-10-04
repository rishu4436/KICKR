import { describe, expect, it } from "vitest";
import {
  buildPhase61World,
  createAndApproveSnapshots,
  ingestScoringEvents,
  fixtureCtx,
} from "./fixtures/phase6_1_harness.js";
import { buildDraftSnapshot } from "../live/snapshot.js";
import { TIE_POLICY_ID } from "../settlement/tie-policy.js";
import { buildMerkleTree, payoutLeaf, verifyMerkleProof, fromHex32 } from "../settlement/merkle.js";
import { ROLE_PERMISSIONS, CAPABILITY_PERMISSIONS } from "../rbac/matrix.js";

describe("Phase 6.1 scoring → settlement E2E", () => {
  it("H2H: events → scores → APPROVED snapshots → calculate → rank → payout → merkle (winner from scoring)", async () => {
    const world = await buildPhase61World({ contestType: "HEAD_TO_HEAD", entrantCount: 2 });
    await ingestScoringEvents(world, "default");
    const approved = await createAndApproveSnapshots(world);
    expect(approved.every((row) => row.status === "APPROVED")).toBe(true);

    // Refuse draft settlement path: insert a loose draft for a fake entry should not be used;
    // calculating without approval for a new contest entry fails when snapshots incomplete.
    await expect(
      world.orchestrator.calculateFromApprovedSnapshots({
        contestId: world.contest.id,
        matchSettlementGate: "FINAL",
        actorId: "scorer",
        nowIso: fixtureCtx().now.toISOString(),
      }),
    ).resolves.toBeTruthy();

    const settlement = await world.settlements.getStatus(world.contest.id);
    expect(settlement).toBeTruthy();
    expect(settlement!.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(settlement!.resultHash).not.toBe("1".repeat(64));
    expect(settlement!.feeRateBps).toBe(1000);
    expect(settlement!.totalPayoutBaseUnits + settlement!.feeBaseUnits).toBe(
      settlement!.totalPotBaseUnits,
    );

    const rows = await world.settlements.getLeaderboard(settlement!.id);
    expect(rows).toHaveLength(2);
    // Winner must come from scoring (AF1 captain on entry0 typically higher)
    const winner = rows.find((row) => row.rank === 1)!;
    const loser = rows.find((row) => row.rank === 2)!;
    expect(winner.finalScoreMilliPoints).toBeGreaterThanOrEqual(loser.finalScoreMilliPoints);
    expect(winner.netPayoutBaseUnits).toBe(settlement!.totalPayoutBaseUnits);
    expect(loser.netPayoutBaseUnits).toBe(0);
    // No second captain/vice pass in settlement — scores match approved snapshot finals
    for (const row of rows) {
      const snap = approved.find((item) => item.entryId === row.entryId)!;
      expect(row.finalScoreMilliPoints).toBe(snap.snapshot.finalScoreMilliPoints);
      expect(row.teamVersionId).toBe(snap.teamVersionId);
      const versionMeta = world.versions.find((v) => v.wallet === world.entries.find((e) => e.id === row.entryId)!.wallet)!;
      expect(row.teamVersionId).toBe(versionMeta.versionAId);
      expect(row.teamVersionId).not.toBe(versionMeta.versionBId);
    }

    await world.settlements.review(settlement!.id, "reviewer", fixtureCtx().now.toISOString());
    await world.settlements.approve(settlement!.id, "reviewer", fixtureCtx().now.toISOString());
    const prepared = await world.orchestrator.prepareIfReady(settlement!.id, fixtureCtx().now.toISOString());
    expect(prepared.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.settlementHash).toMatch(/^[0-9a-f]{64}$/);

    const proof = await world.settlements.claimProof(settlement!.id, winner.entryId);
    const leaf = payoutLeaf(winner.entryId, winner.netPayoutBaseUnits, winner.destinationWallet);
    expect(verifyMerkleProof(leaf, proof.proof.map((h) => fromHex32(h)), fromHex32(prepared.merkleRoot!))).toBe(true);
  });

  it("refuses settlement while snapshot is DRAFT", async () => {
    const world = await buildPhase61World({ contestType: "HEAD_TO_HEAD", entrantCount: 2, clearCatalogEvents: true });
    await ingestScoringEvents(world, "default");
    const recompute = await world.pipeline.recomputeMatch(
      world.contest.matchId,
      fixtureCtx(),
    );
    const entry = world.entries[0]!;
    const score = recompute.contestEntryScores.find((row) => row.entryId === entry.id)!;
    const owned = await world.footballStore.getVersionById(entry.teamVersionId);
    const draft = buildDraftSnapshot({
      matchId: world.contest.matchId,
      contestId: world.contest.id,
      entryId: entry.id,
      version: owned!.version,
      finalScoreMilliPoints: score.milliPoints,
      ranking: null,
      playerScores: score.players,
      dataFinalizationState: "FINAL",
      nowIso: fixtureCtx().now.toISOString(),
    });
    await world.snapshots.insertDraft(draft);
    await expect(
      world.orchestrator.calculateFromApprovedSnapshots({
        contestId: world.contest.id,
        matchSettlementGate: "FINAL",
        actorId: "scorer",
        nowIso: fixtureCtx().now.toISOString(),
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^SNAPSHOT_/) });
  });

  it("Version B after entry does not alter settled Version A score path", async () => {
    const world = await buildPhase61World({ contestType: "HEAD_TO_HEAD", entrantCount: 2 });
    await ingestScoringEvents(world, "default");
    await createAndApproveSnapshots(world);
    const settlement = await world.orchestrator.calculateFromApprovedSnapshots({
      contestId: world.contest.id,
      matchSettlementGate: "FINAL",
      actorId: "scorer",
      nowIso: fixtureCtx().now.toISOString(),
    });
    const rows = await world.settlements.getLeaderboard(settlement.id);
    for (const row of rows) {
      const v = world.versions.find((item) => item.versionAId === row.teamVersionId)!;
      expect(row.captainId).toBe(v.captainId);
      expect(row.viceId).toBe(v.viceId);
      expect(row.teamVersionId).not.toBe(v.versionBId);
    }
  });

  it("captain 2x and vice 3/2 applied once in scoring; settlement uses final only", async () => {
    const world = await buildPhase61World({
      contestType: "HEAD_TO_HEAD",
      entrantCount: 2,
      clearCatalogEvents: true,
      identicalTeams: true,
    });
    await ingestScoringEvents(world, "default");
    const approved = await createAndApproveSnapshots(world);
    const settlement = await world.orchestrator.calculateFromApprovedSnapshots({
      contestId: world.contest.id,
      matchSettlementGate: "FINAL",
      actorId: "scorer",
      nowIso: fixtureCtx().now.toISOString(),
    });
    const rows = await world.settlements.getLeaderboard(settlement.id);
    const entry0 = rows.find((row) => row.entryId === world.entries[0]!.id)!;
    const snap = approved.find((row) => row.entryId === entry0.entryId)!;
    const captain = snap.snapshot.scoreCalculation.playerScores.find((p) => p.role === "captain")!;
    const vice = snap.snapshot.scoreCalculation.playerScores.find((p) => p.role === "vice")!;
    expect(captain.milliPoints).toBe(captain.baseMilliPoints * 2);
    expect(vice.milliPoints).toBe(Math.trunc((vice.baseMilliPoints * 3) / 2));
    expect(entry0.finalScoreMilliPoints).toBe(snap.snapshot.finalScoreMilliPoints);
    expect(entry0.finalScoreMilliPoints).toBe(
      snap.snapshot.scoreCalculation.playerScores.reduce((sum, p) => sum + p.milliPoints, 0),
    );
    expect(entry0.baseScoreMilliPoints).toBe(
      snap.snapshot.scoreCalculation.playerScores.reduce((sum, p) => sum + p.baseMilliPoints, 0),
    );
    expect(captain.baseMilliPoints).toBeGreaterThan(0);
    expect(vice.baseMilliPoints).toBeGreaterThan(0);
  });

  it("tie: identical finals → entry_id_asc better rank through real path", async () => {
    const world = await buildPhase61World({
      contestType: "HEAD_TO_HEAD",
      entrantCount: 2,
      identicalTeams: true,
      clearCatalogEvents: true,
    });
    await ingestScoringEvents(world, "tie");
    await createAndApproveSnapshots(world);
    const settlement = await world.orchestrator.calculateFromApprovedSnapshots({
      contestId: world.contest.id,
      matchSettlementGate: "FINAL",
      actorId: "scorer",
      nowIso: fixtureCtx().now.toISOString(),
    });
    expect(settlement.payload.tiePolicy).toBe(TIE_POLICY_ID);
    const rows = await world.settlements.getLeaderboard(settlement.id);
    expect(rows[0]!.finalScoreMilliPoints).toBe(rows[1]!.finalScoreMilliPoints);
    expect(rows[0]!.entryId < rows[1]!.entryId).toBe(true);
    expect(rows[0]!.rank).toBe(1);
  });

  it("frozen payout policy: mutating template does not change settled math", async () => {
    const world = await buildPhase61World({ contestType: "HEAD_TO_HEAD", entrantCount: 2 });
    await ingestScoringEvents(world, "default");
    await createAndApproveSnapshots(world);
    const before = world.contest.rulesSnapshot.payoutConfiguration;
    await world.contestStore.updateTemplate(
      world.contest.templateId,
      { entryFeeBaseUnits: 99_000_000 },
      fixtureCtx().now,
    );
    const settlement = await world.orchestrator.calculateFromApprovedSnapshots({
      contestId: world.contest.id,
      matchSettlementGate: "FINAL",
      actorId: "scorer",
      nowIso: fixtureCtx().now.toISOString(),
    });
    expect(settlement.entryFeeBaseUnits).toBe(world.contest.rulesSnapshot.entryFeeBaseUnits);
    expect(settlement.entryFeeBaseUnits).not.toBe(99_000_000);
    expect(settlement.payoutConfiguration).toEqual(before);
    expect(settlement.totalPotBaseUnits).toBe(world.contest.rulesSnapshot.entryFeeBaseUnits * 2);
  });

  it("Grand League: rank_bps payouts, fees, no remainder, merkle has every winning claim", async () => {
    const world = await buildPhase61World({ contestType: "GRAND_LEAGUE", entrantCount: 4 });
    await ingestScoringEvents(world, "default");
    await createAndApproveSnapshots(world);
    const settlement = await world.orchestrator.calculateFromApprovedSnapshots({
      contestId: world.contest.id,
      matchSettlementGate: "FINAL",
      actorId: "scorer",
      nowIso: fixtureCtx().now.toISOString(),
    });
    expect(settlement.payoutPolicyType).toBe("GRAND_LEAGUE");
    expect(settlement.totalPayoutBaseUnits + settlement.feeBaseUnits).toBe(settlement.totalPotBaseUnits);
    await world.settlements.review(settlement.id, "r", fixtureCtx().now.toISOString());
    await world.settlements.approve(settlement.id, "r", fixtureCtx().now.toISOString());
    const prepared = await world.orchestrator.prepareIfReady(settlement.id, fixtureCtx().now.toISOString());
    const rows = await world.settlements.getLeaderboard(settlement.id);
    const winners = rows.filter((row) => row.netPayoutBaseUnits > 0);
    expect(winners.length).toBeGreaterThan(0);
    const leaves = winners.map((row) => payoutLeaf(row.entryId, row.netPayoutBaseUnits, row.destinationWallet));
    const tree = buildMerkleTree(leaves);
    expect(Buffer.from(tree.root).toString("hex")).toBe(prepared.merkleRoot);
    for (let i = 0; i < winners.length; i += 1) {
      expect(verifyMerkleProof(leaves[i]!, tree.proofs[i]!, tree.root)).toBe(true);
    }
  });

  it("RBAC: RUN_SETTLEMENT still granted to nobody", () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      expect(permissions).not.toContain("RUN_SETTLEMENT");
    }
    for (const permissions of Object.values(CAPABILITY_PERMISSIONS)) {
      expect(permissions).not.toContain("RUN_SETTLEMENT");
    }
  });
});
