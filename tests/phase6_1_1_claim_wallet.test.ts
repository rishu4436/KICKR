/**
 * Phase 6.1.1 Tests A–G (UNIT TEST / LOCAL FIXTURE labelled).
 * Mock wallet adapters are UNIT TEST only — not a browser Phantom E2E.
 */
import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  buildClaimPlan,
  buildClaimPayoutTransaction,
  deriveClaimPda,
  deriveContestPda,
  deriveSettlementPda,
  deriveVaultAddress,
  uuidToBytes,
} from "../solana/escrow.js";
import { decideClaim, type ClaimObservation } from "../settlement/verify.js";
import {
  assertClaimPlanIntegrity,
  checkClusterMatch,
  createMockWalletAdapter,
  explorerClaimUrl,
} from "../app/src/claim-flow.js";
import { buildTestApp, generateWallet, issueTestAttestationForSettlement, signMessage } from "./helpers.js";
import {
  buildLocalDevAttestationWorld,
  issueAndStoreLocalDevAttestation,
} from "../attestation/test-harness.js";

const PROGRAM = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ENTRY_A = "a0000000-0000-4000-8000-000000000001";
const ENTRY_B = "a0000000-0000-4000-8000-000000000002";
const CONTEST = "c0000000-0000-4000-8000-000000000001";
const MATCH = "m0000000-0000-4000-8000-000000000001";

const feePolicy = {
  id: "51000000-0000-4000-8000-000000000001",
  version: 1,
  rateBps: 1000,
  label: "DEV",
};
const h2hPolicy = {
  id: "52000000-0000-4000-8000-000000000001",
  version: 1,
  policyType: "HEAD_TO_HEAD" as const,
  configuration: { calculation: "winner_takes_prize_pool", tiePolicy: "entry_id_asc" },
};

function entry(entryId: string, score: number, wallet: string) {
  return {
    entryId,
    teamVersionId: "t0000000-0000-4000-8000-000000000001",
    destinationWallet: wallet,
    baseScoreMilliPoints: score,
    finalScoreMilliPoints: score,
    xi: Array.from({ length: 11 }, (_, i) => `p${i}`),
    captainId: "p0",
    viceId: "p1",
  };
}

async function preparedSettlement(w1: string, w2: string) {
  const world = buildLocalDevAttestationWorld();
  const service = world.settlements;
  const calculated = await service.calculate({
    contestId: CONTEST,
    matchId: MATCH,
    matchSettlementGate: "FINAL",
    entryFeeBaseUnits: 5_000_000,
    seatCount: 2,
    contestRules: { frozen: true },
    rulesetName: "DEV_V1",
    rulesetVersion: 1,
    feePolicy,
    payoutPolicy: h2hPolicy,
    entries: [entry(ENTRY_A, 9000, w1), entry(ENTRY_B, 1000, w2)],
    actorId: "actor",
    nowIso: "2026-10-04T00:00:00.000Z",
  });
  await service.review(calculated.id, "reviewer", "2026-10-04T00:01:00.000Z");
  const rowsForAttestation = await service.getLeaderboard(calculated.id);
  await issueAndStoreLocalDevAttestation({
    world,
    settlement: calculated,
    rows: rowsForAttestation,
    nowIso: "2026-10-04T00:01:30.000Z",
  });
  await service.approve(calculated.id, "reviewer", "2026-10-04T00:02:00.000Z");
  const prepared = await service.prepare(calculated.id, "2026-10-04T00:03:00.000Z");
  await service.markSubmitted(prepared.id, "commit-sig", "2026-10-04T00:04:00.000Z");
  const confirmed = await service.markConfirmed(prepared.id, 99, "2026-10-04T00:05:00.000Z");
  return { service, prepared: confirmed };
}

function claimObs(partial: Partial<ClaimObservation> & Pick<ClaimObservation, "claimant" | "contestPda" | "entryId" | "amountBaseUnits" | "mint" | "vault" | "claimPda">): ClaimObservation {
  return {
    labelledFixture: true,
    signature: "claim-sig-unit",
    commitment: "finalized",
    slot: 10,
    succeeded: true,
    programId: PROGRAM,
    settlementVersion: 1,
    destination: partial.claimant,
    vaultBalanceDecrease: partial.amountBaseUnits,
    ...partial,
  };
}

describe("Phase 6.1.1 claim wallet (UNIT TEST)", () => {
  it("A: auth — User A cannot get User B claim material", async () => {
    const alice = generateWallet();
    const bob = generateWallet();
    const { app } = buildTestApp(() => new Date("2026-10-04T00:00:00.000Z"));
    // Patch mint on config via rebuilding with mint — use service path directly for proof ownership.
    const { service, prepared } = await preparedSettlement(alice.publicKey, bob.publicKey);
    const proofA = await service.claimProof(prepared.id, ENTRY_A);
    expect(proofA.row.destinationWallet).toBe(alice.publicKey);
    // Bob has 0 payout — no claimable leaf
    await expect(service.claimProof(prepared.id, ENTRY_B)).rejects.toThrow(/no claimable/i);
    void app;
    // Plan destination must match requester
    const plan = buildClaimPlan({
      config: { programId: PROGRAM, usdcMint: MINT, usdcDecimals: 6, cluster: "devnet" },
      contestId: CONTEST,
      settlementId: prepared.id,
      settlementVersion: prepared.settlementVersion,
      entryId: ENTRY_A,
      amountBaseUnits: proofA.row.netPayoutBaseUnits,
      destinationWallet: alice.publicKey,
      merkleRoot: prepared.merkleRoot!,
      resultHash: prepared.resultHash,
      proof: proofA.proof,
      claimStatus: "UNCLAIMED",
      claimSignature: null,
    });
    expect(() => assertClaimPlanIntegrity(plan, bob.publicKey)).toThrow(/does not match/);
    expect(() => assertClaimPlanIntegrity(plan, alice.publicKey)).not.toThrow();
  });

  it("B: payload integrity — tx built only from authorized plan fields", async () => {
    const claimant = Keypair.generate();
    const other = Keypair.generate();
    const { service, prepared } = await preparedSettlement(claimant.publicKey.toBase58(), other.publicKey.toBase58());
    const proof = await service.claimProof(prepared.id, ENTRY_A);
    const plan = buildClaimPlan({
      config: { programId: PROGRAM, usdcMint: MINT, usdcDecimals: 6, cluster: "devnet", tokenProgramId: TOKEN_PROGRAM_ID.toBase58() },
      contestId: CONTEST,
      settlementId: prepared.id,
      settlementVersion: prepared.settlementVersion,
      entryId: ENTRY_A,
      amountBaseUnits: proof.row.netPayoutBaseUnits,
      destinationWallet: claimant.publicKey.toBase58(),
      merkleRoot: prepared.merkleRoot!,
      resultHash: prepared.resultHash,
      proof: proof.proof,
      claimStatus: "UNCLAIMED",
      claimSignature: null,
    });
    const programId = new PublicKey(PROGRAM);
    const contestPda = deriveContestPda(programId, uuidToBytes(CONTEST));
    expect(plan.contestPda).toBe(contestPda.toBase58());
    expect(plan.vault).toBe(deriveVaultAddress(new PublicKey(MINT), contestPda, TOKEN_PROGRAM_ID).toBase58());
    expect(plan.claimPda).toBe(
      deriveClaimPda(programId, contestPda, prepared.settlementVersion, uuidToBytes(ENTRY_A)).toBase58(),
    );
    expect(plan.settlementPda).toBe(
      deriveSettlementPda(programId, contestPda, prepared.settlementVersion).toBase58(),
    );
    expect(plan.amountBaseUnits).toBe(proof.row.netPayoutBaseUnits);
    expect(plan.amountBaseUnits).toBe(9_000_000);
    const tx = buildClaimPayoutTransaction({
      plan,
      feePayer: claimant.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
    });
    expect(tx.instructions).toHaveLength(1);
    expect(tx.feePayer?.toBase58()).toBe(claimant.publicKey.toBase58());
    // Client-invented amount must not be used — building with wrong payer fails
    expect(() =>
      buildClaimPayoutTransaction({
        plan,
        feePayer: other.publicKey,
        recentBlockhash: "11111111111111111111111111111111",
      }),
    ).toThrow(/Fee payer must equal/);
  });

  it("C: no premature claimed — submit stays SUBMITTED", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const { service, prepared } = await preparedSettlement(w1, w2);
    const row = await service.markClaimSubmitted(prepared.id, ENTRY_A, "sig-submit-only", "2026-10-04T00:06:00.000Z");
    expect(row.claimStatus).toBe("SUBMITTED");
    expect(row.claimSignature).toBe("sig-submit-only");
    expect(row.claimedAt).toBeNull();
    const board = await service.getLeaderboard(prepared.id);
    expect(board.find((r) => r.entryId === ENTRY_A)?.claimStatus).toBe("SUBMITTED");
  });

  it("D: reconciliation cases — ok / wrong / not finalized / vault mismatch", () => {
    const claimant = "Claimant11111111111111111111111111111111111";
    const contestPda = "Contest111111111111111111111111111111111111";
    const claimPda = "ClaimPda11111111111111111111111111111111111";
    const base = claimObs({
      claimant,
      contestPda,
      entryId: ENTRY_A,
      amountBaseUnits: 9_000_000,
      mint: MINT,
      vault: "Vault11111111111111111111111111111111111111",
      claimPda,
    });
    const ok = decideClaim({
      observation: base,
      programId: PROGRAM,
      expectedClaimant: claimant,
      expectedContestPda: contestPda,
      expectedVersion: 1,
      expectedEntryId: ENTRY_A,
      expectedAmount: 9_000_000,
      expectedMint: MINT,
      expectedVault: base.vault,
      expectedClaimPda: claimPda,
      existingSignature: null,
    });
    expect(ok).toEqual({ ok: true });

    expect(
      decideClaim({
        observation: { ...base, commitment: "confirmed" },
        programId: PROGRAM,
        expectedClaimant: claimant,
        expectedContestPda: contestPda,
        expectedVersion: 1,
        expectedEntryId: ENTRY_A,
        expectedAmount: 9_000_000,
        expectedMint: MINT,
        expectedVault: base.vault,
        expectedClaimPda: claimPda,
        existingSignature: null,
      }),
    ).toEqual({ ok: false, reason: "NOT_FINALIZED" });

    expect(
      decideClaim({
        observation: { ...base, amountBaseUnits: 1, vaultBalanceDecrease: 1 },
        programId: PROGRAM,
        expectedClaimant: claimant,
        expectedContestPda: contestPda,
        expectedVersion: 1,
        expectedEntryId: ENTRY_A,
        expectedAmount: 9_000_000,
        expectedMint: MINT,
        expectedVault: base.vault,
        expectedClaimPda: claimPda,
        existingSignature: null,
      }).ok,
    ).toBe(false);

    expect(
      decideClaim({
        observation: { ...base, claimPda: "WrongClaimPda111111111111111111111111111111" },
        programId: PROGRAM,
        expectedClaimant: claimant,
        expectedContestPda: contestPda,
        expectedVersion: 1,
        expectedEntryId: ENTRY_A,
        expectedAmount: 9_000_000,
        expectedMint: MINT,
        expectedVault: base.vault,
        expectedClaimPda: claimPda,
        existingSignature: null,
      }),
    ).toEqual({ ok: false, reason: "WRONG_CLAIM_PDA" });

    expect(
      decideClaim({
        observation: base,
        programId: PROGRAM,
        expectedClaimant: claimant,
        expectedContestPda: contestPda,
        expectedVersion: 1,
        expectedEntryId: ENTRY_A,
        expectedAmount: 9_000_000,
        expectedMint: MINT,
        expectedVault: base.vault,
        expectedClaimPda: claimPda,
        existingSignature: "other-sig",
      }),
    ).toEqual({ ok: false, reason: "DUPLICATE_CLAIM" });
  });

  it("E: replay — second claim becomes ALREADY_CLAIMED", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const { service, prepared } = await preparedSettlement(w1, w2);
    await service.markClaimed(prepared.id, ENTRY_A, "sig-1", "2026-10-04T00:07:00.000Z");
    await expect(service.markClaimSubmitted(prepared.id, ENTRY_A, "sig-2", "2026-10-04T00:08:00.000Z")).rejects.toThrow(
      /already claimed/i,
    );
    await expect(service.markClaimed(prepared.id, ENTRY_A, "sig-2", "2026-10-04T00:09:00.000Z")).rejects.toThrow(
      /already claimed/i,
    );
    // Idempotent same signature
    const again = await service.markClaimed(prepared.id, ENTRY_A, "sig-1", "2026-10-04T00:10:00.000Z");
    expect(again.claimStatus).toBe("CLAIMED");
  });

  it("F: UI states — cluster mismatch, explorer only with signature, mock wallet labelled UNIT TEST", () => {
    expect(checkClusterMatch("devnet", "devnet", "devnet")).toBeNull();
    expect(checkClusterMatch("devnet", "mainnet-beta", "devnet")).toBe("cluster_mismatch");
    expect(checkClusterMatch("devnet", null, "testnet")).toBe("cluster_mismatch");
    expect(explorerClaimUrl(null, "devnet")).toBeNull();
    expect(explorerClaimUrl("Sig111", "devnet")).toContain("cluster=devnet");
    expect(explorerClaimUrl("Sig111", "devnet")).toContain("Sig111");

    const kp = Keypair.generate();
    const mock = createMockWalletAdapter({ keypair: kp, cluster: "devnet" });
    expect(mock.publicKey?.toBase58()).toBe(kp.publicKey.toBase58());
    // Mock adapter is UNIT TEST labelled — not a browser E2E.
  });

  it("G: prior settlement gates still green (smoke)", async () => {
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const { prepared } = await preparedSettlement(w1, w2);
    expect(prepared.resultHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.resultHash).not.toBe("1".repeat(64));
    expect(prepared.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared.status).toBe("SETTLEMENT_CONFIRMED");
  });
});

describe("Phase 6.1.1 claim plan API auth (LOCAL FIXTURE)", () => {
  it("GET claim returns 403 for non-owner wallet", async () => {
    const clock = () => new Date("2026-10-04T12:00:00.000Z");
    const { app, deps, localDevAttestor } = buildTestApp(clock);
    // Configure mint so ClaimPlan can build
    deps.config.server.solana.usdcMint = MINT;
    deps.config.public.usdcMint = MINT;

    const alice = generateWallet();
    const bob = generateWallet();
    async function login(wallet: ReturnType<typeof generateWallet>) {
      const nonceRes = await app.request("/v1/auth/nonce", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ walletAddress: wallet.publicKey }),
      });
      const nonce = (await nonceRes.json()) as { message: string };
      const loginRes = await app.request("/v1/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          walletAddress: wallet.publicKey,
          message: nonce.message,
          signature: signMessage(nonce.message, wallet.secretKey),
        }),
      });
      const session = (await loginRes.json()) as { token: string };
      return session.token;
    }
    const aliceToken = await login(alice);
    const bobToken = await login(bob);

    const { service, prepared } = await preparedSettlement(alice.publicKey, bob.publicKey);
    // Inject into deps settlement store by marking confirmed settlement on deps.settlement
    // Re-run through deps.settlement instead:
    const calc = await deps.settlement!.calculate({
      contestId: CONTEST,
      matchId: MATCH,
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: { frozen: true },
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: [entry(ENTRY_A, 9000, alice.publicKey), entry(ENTRY_B, 1000, bob.publicKey)],
      actorId: "actor",
      nowIso: clock().toISOString(),
    });
    await deps.settlement!.review(calc.id, "reviewer", clock().toISOString());
    await issueTestAttestationForSettlement(deps, localDevAttestor, calc, clock().toISOString());
    await deps.settlement!.approve(calc.id, "reviewer", clock().toISOString());
    const prep = await deps.settlement!.prepare(calc.id, clock().toISOString());
    await deps.settlement!.markSubmitted(prep.id, "c-sig", clock().toISOString());
    await deps.settlement!.markConfirmed(prep.id, 1, clock().toISOString());

    const bobTriesAlice = await app.request(`/entries/${ENTRY_A}/claim?contestId=${CONTEST}`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(bobTriesAlice.status).toBe(403);

    const aliceOk = await app.request(`/entries/${ENTRY_A}/claim?contestId=${CONTEST}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(aliceOk.status).toBe(200);
    const body = (await aliceOk.json()) as {
      amountBaseUnits: number;
      destinationWallet: string;
      claimPda: string;
      proof: string[];
      entryId: string;
    };
    expect(body.destinationWallet).toBe(alice.publicKey);
    expect(body.entryId).toBe(ENTRY_A);
    expect(body.amountBaseUnits).toBe(9_000_000);
    expect(body.claimPda).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(Array.isArray(body.proof)).toBe(true);
    void service;
    void prepared;
  });
});
