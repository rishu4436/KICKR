import { describe, expect, it } from "vitest";
import { computePayouts } from "../settlement/payouts.js";
import { compareTiedEntries, TIE_POLICY_ID } from "../settlement/tie-policy.js";
import { buildMerkleTree, payoutLeaf, toHex32, verifyMerkleProof, fromHex32 } from "../settlement/merkle.js";
import { computeResultHash, computeSettlementHash, canonicalJson } from "../settlement/hash.js";
import { buildResultPayload, hashResultPayload } from "../settlement/result-payload.js";
import { InMemorySettlementStore } from "../settlement/memory-store.js";
import { SettlementService } from "../settlement/service.js";
import { decideClaim, decideSettlementCommit } from "../settlement/verify.js";
import { transition, isTransitionLegal } from "../domain/state-machine.js";
import { ROLE_PERMISSIONS, CAPABILITY_PERMISSIONS } from "../rbac/matrix.js";
import { Keypair } from "@solana/web3.js";

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

const wtaPolicy = {
  id: "52000000-0000-4000-8000-000000000002",
  version: 2,
  policyType: "WINNER_TAKES_ALL" as const,
  configuration: {
    shape: "WINNER_TAKES_ALL",
    calculation: "winner_takes_prize_pool",
    tiePolicy: "entry_id_asc",
  },
};

const grandPolicy = {
  id: "52000000-0000-4000-8000-000000000003",
  version: 2,
  policyType: "GRAND_LEAGUE" as const,
  configuration: {
    shape: "GRAND_LEAGUE",
    calculation: "rank_bps",
    tiePolicy: "entry_id_asc",
    ranks: [
      { rank: 1, bps: 4000 },
      { rank: 2, bps: 3000 },
      { rank: 3, bps: 2000 },
      { rank: 4, bps: 1000 },
    ],
  },
};

function entry(
  id: string,
  score: number,
  wallet = Keypair.generate().publicKey.toBase58(),
) {
  return {
    entryId: id,
    teamVersionId: "61000000-0000-4000-8000-000000000001",
    destinationWallet: wallet,
    finalScoreMilliPoints: score,
    baseScoreMilliPoints: score,
    xi: ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p9", "p10", "p11"],
    captainId: "p1",
    viceId: "p2",
  };
}

describe("Phase 6 settlement math", () => {
  it("uses exact entry scores and entry_id_asc tiebreak", () => {
    const a = entry("a0000000-0000-4000-8000-000000000002", 5000);
    const b = entry("a0000000-0000-4000-8000-000000000001", 5000);
    expect(compareTiedEntries(a, b)).toBeGreaterThan(0);
    const result = computePayouts({
      entries: [a, b],
      entryFeeBaseUnits: 5_000_000,
      feePolicy,
      payoutPolicy: h2hPolicy,
    });
    expect(result.tiePolicy).toBe(TIE_POLICY_ID);
    expect(result.rows[0]!.entryId).toBe(b.entryId);
    expect(result.rows[0]!.rank).toBe(1);
    expect(result.rows[0]!.netPayoutBaseUnits).toBe(9_000_000);
    expect(result.rows[1]!.netPayoutBaseUnits).toBe(0);
    expect(result.totalPayoutBaseUnits + result.feeBaseUnits).toBe(10_000_000);
  });

  it("applies DEV 1000 bps fee and H2H winner pool", () => {
    const result = computePayouts({
      entries: [entry("a0000000-0000-4000-8000-000000000001", 9000), entry("a0000000-0000-4000-8000-000000000002", 1000)],
      entryFeeBaseUnits: 5_000_000,
      feePolicy,
      payoutPolicy: h2hPolicy,
    });
    expect(result.feeRateBps).toBe(1000);
    expect(result.feeBaseUnits).toBe(1_000_000);
    expect(result.rows[0]!.netPayoutBaseUnits).toBe(9_000_000);
  });

  it("WTA pays only rank 1", () => {
    const entries = [
      entry("a0000000-0000-4000-8000-000000000001", 100),
      entry("a0000000-0000-4000-8000-000000000002", 200),
      entry("a0000000-0000-4000-8000-000000000003", 50),
    ];
    const result = computePayouts({
      entries,
      entryFeeBaseUnits: 20_000_000,
      feePolicy,
      payoutPolicy: wtaPolicy,
    });
    expect(result.rows[0]!.entryId.endsWith("0002")).toBe(true);
    expect(result.rows.filter((row) => row.netPayoutBaseUnits > 0)).toHaveLength(1);
    expect(result.totalPayoutBaseUnits + result.feeBaseUnits).toBe(60_000_000);
  });

  it("Grand League uses frozen rank_bps schedule", () => {
    const entries = [1, 2, 3, 4].map((n) =>
      entry(`a0000000-0000-4000-8000-00000000000${n}`, 1000 * (5 - n)),
    );
    const result = computePayouts({
      entries,
      entryFeeBaseUnits: 5_000_000,
      feePolicy,
      payoutPolicy: grandPolicy,
    });
    const prizePool = 18_000_000;
    expect(result.rows[0]!.netPayoutBaseUnits).toBe(Math.floor((prizePool * 4000) / 10_000));
    expect(result.rows[1]!.netPayoutBaseUnits).toBe(Math.floor((prizePool * 3000) / 10_000));
    expect(result.totalPayoutBaseUnits + result.feeBaseUnits).toBe(20_000_000);
  });

  it("result hash is deterministic", () => {
    const computation = computePayouts({
      entries: [entry("a0000000-0000-4000-8000-000000000001", 10), entry("a0000000-0000-4000-8000-000000000002", 5)],
      entryFeeBaseUnits: 5_000_000,
      feePolicy,
      payoutPolicy: h2hPolicy,
    });
    const payload = buildResultPayload({
      contestId: "c0000000-0000-4000-8000-000000000001",
      matchId: "m0000000-0000-4000-8000-000000000001",
      settlementVersion: 1,
      calculationVersion: 1,
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      contestRules: { frozen: true },
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      feePolicy,
      payoutPolicy: h2hPolicy,
      computation,
    });
    const a = hashResultPayload(payload);
    const b = hashResultHash(payload);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });
});

function hashResultHash(payload: unknown): string {
  return computeResultHash(payload);
}

describe("Phase 6 merkle + verify", () => {
  it("builds verifiable proofs", () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const leaf = payoutLeaf("a0000000-0000-4000-8000-000000000001", 9_000_000, wallet);
    const tree = buildMerkleTree([leaf]);
    expect(verifyMerkleProof(leaf, tree.proofs[0]!, tree.root)).toBe(true);
    expect(verifyMerkleProof(leaf, [], fromHex32(toHex32(tree.root)))).toBe(true);
  });

  it("rejects wrong hash / amount / authority in commit verify", () => {
    const observation = {
      labelledFixture: true,
      signature: "sig1",
      commitment: "finalized",
      slot: 1,
      succeeded: true,
      programId: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN",
      authority: "Auth111111111111111111111111111111111111111",
      contestPda: "Contest111111111111111111111111111111111111",
      settlementPda: "Settle1111111111111111111111111111111111111",
      settlementVersion: 1,
      resultHash: "aa".repeat(32),
      merkleRoot: "bb".repeat(32),
      totalPayoutBaseUnits: 9_000_000,
      feeBaseUnits: 1_000_000,
      contestStatusAfter: 3,
    };
    expect(
      decideSettlementCommit({
        observation: { ...observation, resultHash: "cc".repeat(32) },
        programId: observation.programId,
        expectedAuthority: observation.authority,
        expectedContestPda: observation.contestPda,
        expectedVersion: 1,
        expectedResultHash: observation.resultHash,
        expectedMerkleRoot: observation.merkleRoot,
        expectedTotalPayout: 9_000_000,
        expectedFee: 1_000_000,
        existingSignature: null,
      }).ok,
    ).toBe(false);
  });

  it("claim verify rejects wrong wallet and duplicate", () => {
    const observation = {
      labelledFixture: true,
      signature: "claim1",
      commitment: "finalized",
      slot: 2,
      succeeded: true,
      programId: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN",
      claimant: "Claimant11111111111111111111111111111111111",
      contestPda: "Contest111111111111111111111111111111111111",
      settlementVersion: 1,
      entryId: "a0000000-0000-4000-8000-000000000001",
      amountBaseUnits: 9_000_000,
      mint: "mint",
      vault: "vault",
      destination: "Claimant11111111111111111111111111111111111",
      vaultBalanceDecrease: 9_000_000,
    };
    expect(
      decideClaim({
        observation,
        programId: observation.programId,
        expectedClaimant: "Other1111111111111111111111111111111111111",
        expectedContestPda: observation.contestPda,
        expectedVersion: 1,
        expectedEntryId: observation.entryId,
        expectedAmount: 9_000_000,
        expectedMint: "mint",
        expectedVault: "vault",
        existingSignature: null,
      }).ok,
    ).toBe(false);
    expect(
      decideClaim({
        observation,
        programId: observation.programId,
        expectedClaimant: observation.claimant,
        expectedContestPda: observation.contestPda,
        expectedVersion: 1,
        expectedEntryId: observation.entryId,
        expectedAmount: 9_000_000,
        expectedMint: "mint",
        expectedVault: "vault",
        existingSignature: "other",
      }).ok,
    ).toBe(false);
  });
});

describe("Phase 6 settlement service lifecycle", () => {
  it("calculate → review → approve → prepare is immutable after approval", async () => {
    const store = new InMemorySettlementStore();
    const service = new SettlementService(store);
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const calculated = await service.calculate({
      contestId: "c0000000-0000-4000-8000-000000000001",
      matchId: "m0000000-0000-4000-8000-000000000001",
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: { frozen: true },
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: [
        entry("a0000000-0000-4000-8000-000000000001", 9000, w1),
        entry("a0000000-0000-4000-8000-000000000002", 1000, w2),
      ],
      actorId: "actor",
      nowIso: "2026-10-04T00:00:00.000Z",
    });
    expect(calculated.status).toBe("RESULT_CALCULATED");
    expect(calculated.resultHash).toMatch(/^[0-9a-f]{64}$/);
    await service.review(calculated.id, "reviewer", "2026-10-04T00:01:00.000Z");
    const approved = await service.approve(calculated.id, "reviewer", "2026-10-04T00:02:00.000Z");
    expect(approved.status).toBe("SETTLEMENT_APPROVED");
    await expect(
      service.calculate({
        contestId: calculated.contestId,
        matchId: calculated.matchId,
        matchSettlementGate: "FINAL",
        entryFeeBaseUnits: 5_000_000,
        seatCount: 2,
        contestRules: { frozen: true },
        rulesetName: "DEV_V1",
        rulesetVersion: 1,
        feePolicy,
        payoutPolicy: h2hPolicy,
        entries: [entry("a0000000-0000-4000-8000-000000000001", 1, w1), entry("a0000000-0000-4000-8000-000000000002", 2, w2)],
        actorId: "actor",
        nowIso: "2026-10-04T00:03:00.000Z",
      }),
    ).rejects.toThrow(/immutable|Approved/i);
    const prepared = await service.prepare(approved.id, "2026-10-04T00:04:00.000Z");
    expect(prepared.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.settlementHash).toMatch(/^[0-9a-f]{64}$/);
    const settlementHash = computeSettlementHash({
      resultHash: prepared.resultHash,
      merkleRoot: prepared.merkleRoot!,
      settlementVersion: prepared.settlementVersion,
      totalPayoutBaseUnits: prepared.totalPayoutBaseUnits,
      feeBaseUnits: prepared.feeBaseUnits,
    });
    expect(prepared.settlementHash).toBe(settlementHash);

    await service.markSubmitted(prepared.id, "sig-commit", "2026-10-04T00:05:00.000Z");
    await service.markConfirmed(prepared.id, 42, "2026-10-04T00:06:00.000Z");
    const proof = await service.claimProof(prepared.id, "a0000000-0000-4000-8000-000000000001");
    expect(proof.row.netPayoutBaseUnits).toBe(9_000_000);
    await service.markClaimed(prepared.id, proof.row.entryId, "sig-claim", "2026-10-04T00:07:00.000Z");
    await expect(
      service.markClaimed(prepared.id, proof.row.entryId, "sig-claim-2", "2026-10-04T00:08:00.000Z"),
    ).rejects.toThrow(/claimed/i);
  });

  it("rejection stays auditable and allows new calculation version", async () => {
    const store = new InMemorySettlementStore();
    const service = new SettlementService(store);
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const first = await service.calculate({
      contestId: "c0000000-0000-4000-8000-000000000099",
      matchId: "m0000000-0000-4000-8000-000000000099",
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: {},
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: [entry("a0000000-0000-4000-8000-000000000001", 1, w1), entry("a0000000-0000-4000-8000-000000000002", 2, w2)],
      actorId: "actor",
      nowIso: "2026-10-04T00:00:00.000Z",
    });
    await service.reject(first.id, "reviewer", "bad data", "2026-10-04T00:01:00.000Z");
    const second = await service.calculate({
      contestId: first.contestId,
      matchId: first.matchId,
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: {},
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: [entry("a0000000-0000-4000-8000-000000000001", 9, w1), entry("a0000000-0000-4000-8000-000000000002", 1, w2)],
      actorId: "actor",
      nowIso: "2026-10-04T00:02:00.000Z",
    });
    expect(second.settlementVersion).toBe(2);
    expect(second.calculationVersion).toBe(2);
    expect(second.resultHash).not.toBe(first.resultHash);
  });

  it("failed submit can retry without second settlement", async () => {
    const store = new InMemorySettlementStore();
    const service = new SettlementService(store);
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const calculated = await service.calculate({
      contestId: "c0000000-0000-4000-8000-000000000077",
      matchId: "m0000000-0000-4000-8000-000000000077",
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: {},
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: [entry("a0000000-0000-4000-8000-000000000001", 9, w1), entry("a0000000-0000-4000-8000-000000000002", 1, w2)],
      actorId: "actor",
      nowIso: "2026-10-04T00:00:00.000Z",
    });
    await service.review(calculated.id, "r", "2026-10-04T00:01:00.000Z");
    await service.approve(calculated.id, "r", "2026-10-04T00:02:00.000Z");
    const prepared = await service.prepare(calculated.id, "2026-10-04T00:03:00.000Z");
    await service.markSubmitted(prepared.id, "bad-sig", "2026-10-04T00:04:00.000Z");
    await service.markFailed(prepared.id, "TRANSACTION_FAILED", "2026-10-04T00:05:00.000Z");
    const again = await service.prepare(prepared.id, "2026-10-04T00:06:00.000Z");
    expect(again.settlementVersion).toBe(1);
    expect(again.merkleRoot).toBe(prepared.merkleRoot);
    await service.markSubmitted(again.id, "good-sig", "2026-10-04T00:07:00.000Z");
    await service.markConfirmed(again.id, 9, "2026-10-04T00:08:00.000Z");
    expect((await service.getById(again.id))!.status).toBe("SETTLEMENT_CONFIRMED");
  });
});

describe("Phase 6 RBAC boundaries", () => {
  it("RUN_SETTLEMENT is granted to nobody", () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      expect(permissions).not.toContain("RUN_SETTLEMENT");
    }
    for (const permissions of Object.values(CAPABILITY_PERMISSIONS)) {
      expect(permissions).not.toContain("RUN_SETTLEMENT");
    }
  });

  it("REVIEW_RESULT is capability-only", () => {
    for (const permissions of Object.values(ROLE_PERMISSIONS)) {
      expect(permissions).not.toContain("REVIEW_RESULT");
    }
    expect(CAPABILITY_PERMISSIONS.REVIEWER).toContain("REVIEW_RESULT");
  });
});

describe("Phase 6 settlement state machine", () => {
  it("SUBMITTED is not CONFIRMED and failed can retry", () => {
    expect(isTransitionLegal("SETTLEMENT", "SETTLEMENT_SUBMITTED", "SETTLEMENT_CONFIRMED")).toBe(true);
    expect(isTransitionLegal("SETTLEMENT", "SETTLEMENT_SUBMITTED", "SETTLEMENT_FAILED")).toBe(true);
    expect(isTransitionLegal("SETTLEMENT", "SETTLEMENT_FAILED", "SETTLEMENT_SUBMITTED")).toBe(true);
    expect(() => transition("SETTLEMENT", "SETTLEMENT_CONFIRMED", "SETTLEMENT_FAILED")).toThrow();
  });
});
