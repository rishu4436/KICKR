import type { Context, Hono } from "hono";
import type { Principal } from "../auth/types.js";
import type { Permission } from "../rbac/permissions.js";
import { AppError } from "../shared/errors.js";
import type { AppEnv, AppDeps } from "./server.js";
import { decideClaim, decideSettlementCommit, type ClaimObservation, type SettlementCommitObservation } from "../settlement/verify.js";

/**
 * Settlement APIs. Never accept an arbitrary winner wallet + amount.
 * Payouts come only from the immutable approved result.
 * RUN_SETTLEMENT remains granted to nobody in the role matrix.
 */
export function registerSettlementRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
  authorize: (c: Context<AppEnv>, permission: Permission) => Promise<void>,
): void {
  app.get("/contests/:id/settlement", async (c) => {
    await authenticate(c);
    const service = requireSettlement(deps);
    const settlement = await service.getStatus(c.req.param("id"));
    if (!settlement) {
      return c.json({ status: null });
    }
    return c.json(publicSettlement(settlement));
  });


  app.get("/contests/:id/my-result", async (c) => {
    const principal = await authenticate(c);
    const service = requireSettlement(deps);
    const contestId = c.req.param("id");
    const entries = await deps.contests.listDeposits(contestId);
    const mine = entries.find((entry) => entry.wallet === principal.walletAddress && entry.status === "CONFIRMED");
    if (!mine) {
      throw new AppError("NOT_FOUND", 404, "No confirmed entry for this wallet on the contest");
    }
    const settlement = await service.getStatus(contestId);
    const contest = await deps.contests.getContest(contestId);
    if (!contest) {
      throw new AppError("NOT_FOUND", 404, "Contest not found");
    }
    let row = null as Awaited<ReturnType<typeof service.getLeaderboard>>[number] | null;
    let claimUiState = "pending_result";
    if (settlement) {
      const rows = await service.getLeaderboard(settlement.id);
      row = rows.find((item) => item.entryId === mine.id) ?? null;
      claimUiState = deriveClaimUiState(settlement.status, row);
    }
    const totalEntries = settlement?.confirmedEntries ?? entries.filter((e) => e.status === "CONFIRMED").length;
    return c.json({
      contestId,
      matchId: contest.matchId,
      entryId: mine.id,
      teamVersionId: mine.teamVersionId,
      xi: row?.xi ?? null,
      captainId: row?.captainId ?? null,
      viceId: row?.viceId ?? null,
      baseScoreMilliPoints: row?.baseScoreMilliPoints ?? null,
      finalScoreMilliPoints: row?.finalScoreMilliPoints ?? null,
      rank: row?.rank ?? null,
      totalEntries,
      prizeBaseUnits: row?.netPayoutBaseUnits ?? null,
      payoutStatus: row ? (row.netPayoutBaseUnits > 0 ? "WINNER" : "NO_PRIZE") : null,
      settlementStatus: settlement?.status ?? null,
      resultHash: settlement?.resultHash ?? null,
      settlementHash: settlement?.settlementHash ?? null,
      claimStatus: row?.claimStatus ?? "UNCLAIMED",
      claimUiState,
      claimSignature: row?.claimSignature ?? null,
      explorerUrl: explorerUrl(row?.claimSignature ?? null, deps.config.public.solanaCluster),
      stages: settlementStages(settlement?.status ?? null, row?.claimStatus ?? null),
    });
  });

  app.post("/contests/:id/settlement/calculate", async (c) => {
    const principal = await authenticate(c);
    await authorize(c, "RUN_SCORING");
    const orch = deps.settlementOrchestrator;
    if (!orch) {
      throw new AppError("NOT_FOUND", 404, "Settlement orchestrator is not available");
    }
    const settlement = await orch.calculateFromApprovedSnapshots({
      contestId: c.req.param("id"),
      matchSettlementGate: "FINAL",
      actorId: principal.accountId,
      nowIso: deps.clock().toISOString(),
    });
    await appendAudit(deps, c, principal, "RESULT_CALCULATED", settlement.id, {
      contestId: settlement.contestId,
      resultHash: settlement.resultHash,
      settlementVersion: settlement.settlementVersion,
    });
    return c.json({
      id: settlement.id,
      status: settlement.status,
      resultHash: settlement.resultHash,
      settlementVersion: settlement.settlementVersion,
    });
  });

  app.post("/settlements/:id/claim-submit", async (c) => {
    const principal = await authenticate(c);
    const service = requireSettlement(deps);
    const body = (await c.req.json()) as { entryId: string; signature: string };
    if (!body.entryId || !body.signature) {
      throw new AppError("VALIDATION", 400, "entryId and signature required");
    }
    const proof = await service.claimProof(c.req.param("id"), body.entryId);
    if (proof.row.destinationWallet !== principal.walletAddress) {
      throw new AppError("FORBIDDEN", 403, "Claimant wallet does not match authenticated entry destination");
    }
    // Record submitted only — never claimed until reconcile verifies finalized chain tx.
    const row = await service.markClaimSubmitted(
      c.req.param("id"),
      body.entryId,
      body.signature,
      deps.clock().toISOString(),
    );
    return c.json({
      entryId: row.entryId,
      claimStatus: row.claimStatus,
      claimUiState: "submitted",
      claimSignature: row.claimSignature,
      explorerUrl: null,
      note: "Submitted is not claimed. Wait for independent finalized verification.",
    });
  });

  app.get("/contests/:id/settlement/result", async (c) => {
    await authenticate(c);
    const service = requireSettlement(deps);
    const settlement = await service.getStatus(c.req.param("id"));
    if (!settlement) {
      throw new AppError("NOT_FOUND", 404, "No settlement result");
    }
    if (!isApprovedStatus(settlement.status)) {
      throw new AppError("FORBIDDEN", 403, "Approved result is not available yet");
    }
    const rows = await service.getLeaderboard(settlement.id);
    return c.json({
      settlementId: settlement.id,
      status: settlement.status,
      resultHash: settlement.resultHash,
      settlementVersion: settlement.settlementVersion,
      payload: settlement.payload,
      leaderboard: rows.map((row) => ({
        entryId: row.entryId,
        rank: row.rank,
        finalScoreMilliPoints: row.finalScoreMilliPoints,
        netPayoutBaseUnits: row.netPayoutBaseUnits,
        destinationWallet: row.destinationWallet,
        claimStatus: row.claimStatus,
        claimSignature: row.claimSignature,
      })),
    });
  });

  app.get("/contests/:id/settlement/leaderboard", async (c) => {
    await authenticate(c);
    const service = requireSettlement(deps);
    const settlement = await service.getStatus(c.req.param("id"));
    if (!settlement) {
      throw new AppError("NOT_FOUND", 404, "No settlement");
    }
    const rows = await service.getLeaderboard(settlement.id);
    return c.json({
      settlementId: settlement.id,
      status: settlement.status,
      rows: rows.map((row) => ({
        entryId: row.entryId,
        rank: row.rank,
        finalScoreMilliPoints: row.finalScoreMilliPoints,
        netPayoutBaseUnits: row.netPayoutBaseUnits,
        claimStatus: row.claimStatus,
      })),
    });
  });

  app.get("/entries/:id/payout", async (c) => {
    await authenticate(c);
    const service = requireSettlement(deps);
    const contestId = c.req.query("contestId");
    if (!contestId) {
      throw new AppError("VALIDATION", 400, "contestId query required");
    }
    const settlement = await service.getStatus(contestId);
    if (!settlement) {
      throw new AppError("NOT_FOUND", 404, "No settlement");
    }
    const rows = await service.getLeaderboard(settlement.id);
    const row = rows.find((item) => item.entryId === c.req.param("id"));
    if (!row) {
      throw new AppError("NOT_FOUND", 404, "Entry payout not found");
    }
    return c.json({
      entryId: row.entryId,
      rank: row.rank,
      netPayoutBaseUnits: row.netPayoutBaseUnits,
      destinationWallet: row.destinationWallet,
      claimStatus: row.claimStatus,
      claimSignature: row.claimSignature,
      explorerUrl: explorerUrl(row.claimSignature, deps.config.public.solanaCluster),
      settlementStatus: settlement.status,
      resultHash: settlement.resultHash,
    });
  });

  app.get("/entries/:id/claim", async (c) => {
    await authenticate(c);
    const service = requireSettlement(deps);
    const contestId = c.req.query("contestId");
    if (!contestId) {
      throw new AppError("VALIDATION", 400, "contestId query required");
    }
    const settlement = await service.getStatus(contestId);
    if (!settlement || settlement.status !== "SETTLEMENT_CONFIRMED") {
      throw new AppError("NOT_READY", 409, "Settlement is not confirmed on-chain");
    }
    const proof = await service.claimProof(settlement.id, c.req.param("id"));
    return c.json({
      settlementVersion: settlement.settlementVersion,
      resultHash: settlement.resultHash,
      merkleRoot: settlement.merkleRoot,
      entryId: proof.row.entryId,
      amountBaseUnits: proof.row.netPayoutBaseUnits,
      destinationWallet: proof.row.destinationWallet,
      proof: proof.proof,
      claimStatus: proof.row.claimStatus,
      claimSignature: proof.row.claimSignature,
    });
  });

  app.post("/settlements/:id/review", async (c) => {
    const principal = await authenticate(c);
    await authorize(c, "REVIEW_RESULT");
    const service = requireSettlement(deps);
    const settlement = await service.review(c.req.param("id"), principal.accountId, deps.clock().toISOString());
    await appendAudit(deps, c, principal, "RESULT_REVIEWED", settlement.id, {
      contestId: settlement.contestId,
      resultHash: settlement.resultHash,
    });
    return c.json({ id: settlement.id, status: settlement.status, resultHash: settlement.resultHash });
  });

  app.post("/settlements/:id/reject", async (c) => {
    const principal = await authenticate(c);
    await authorize(c, "REVIEW_RESULT");
    const service = requireSettlement(deps);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
    const reason = body.reason?.trim() || "rejected";
    const settlement = await service.reject(
      c.req.param("id"),
      principal.accountId,
      reason,
      deps.clock().toISOString(),
    );
    await appendAudit(deps, c, principal, "RESULT_REJECTED", settlement.id, {
      contestId: settlement.contestId,
      resultHash: settlement.resultHash,
      reason,
    });
    return c.json({ id: settlement.id, status: settlement.status });
  });

  app.post("/settlements/:id/approve", async (c) => {
    const principal = await authenticate(c);
    await authorize(c, "REVIEW_RESULT");
    const service = requireSettlement(deps);
    const settlement = await service.approve(c.req.param("id"), principal.accountId, deps.clock().toISOString());
    await appendAudit(deps, c, principal, "RESULT_APPROVED", settlement.id, {
      contestId: settlement.contestId,
      resultHash: settlement.resultHash,
      approvedBy: principal.accountId,
    });
    return c.json({
      id: settlement.id,
      status: settlement.status,
      resultHash: settlement.resultHash,
      approvedAt: settlement.approvedAt,
    });
  });

  app.post("/settlements/:id/prepare", async (c) => {
    const principal = await authenticate(c);
    await authorize(c, "RUN_SETTLEMENT");
    const service = requireSettlement(deps);
    const settlement = deps.settlementOrchestrator
      ? await deps.settlementOrchestrator.prepareIfReady(c.req.param("id"), deps.clock().toISOString())
      : await service.prepare(c.req.param("id"), deps.clock().toISOString());
    await appendAudit(deps, c, principal, "SETTLEMENT_PREPARED", settlement.id, {
      contestId: settlement.contestId,
      resultHash: settlement.resultHash,
      merkleRoot: settlement.merkleRoot,
      settlementHash: settlement.settlementHash,
    });
    return c.json({
      id: settlement.id,
      status: settlement.status,
      merkleRoot: settlement.merkleRoot,
      settlementHash: settlement.settlementHash,
      resultHash: settlement.resultHash,
      settlementVersion: settlement.settlementVersion,
      totalPayoutBaseUnits: settlement.totalPayoutBaseUnits,
      feeBaseUnits: settlement.feeBaseUnits,
    });
  });

  /** Observe a finalized commit tx. Does not accept arbitrary payouts. */
  app.post("/settlements/:id/reconcile-commit", async (c) => {
    const principal = await authenticate(c);
    await authorize(c, "RUN_SETTLEMENT");
    const service = requireSettlement(deps);
    const latest = await service.getById(c.req.param("id"));
    if (!latest) {
      throw new AppError("NOT_FOUND", 404, "Settlement not found");
    }
    if (!latest.merkleRoot) {
      throw new AppError("NOT_PREPARED", 409, "Settlement must be prepared before reconcile");
    }
    const body = (await c.req.json()) as {
      observation: SettlementCommitObservation;
      expectedAuthority: string;
      expectedContestPda: string;
    };
    const decision = decideSettlementCommit({
      observation: body.observation,
      programId: deps.config.server.solana.escrowProgramId,
      expectedAuthority: body.expectedAuthority,
      expectedContestPda: body.expectedContestPda,
      expectedVersion: latest.settlementVersion,
      expectedResultHash: latest.resultHash,
      expectedMerkleRoot: latest.merkleRoot,
      expectedTotalPayout: latest.totalPayoutBaseUnits,
      expectedFee: latest.feeBaseUnits,
      existingSignature: latest.status === "SETTLEMENT_CONFIRMED" ? latest.commitSignature : null,
    });
    if (!decision.ok) {
      if (
        body.observation.commitment === "finalized" &&
        !body.observation.succeeded &&
        latest.status === "SETTLEMENT_SUBMITTED"
      ) {
        // Reconcile chain before failure: only mark failed when the observed tx itself failed.
        await service.markFailed(latest.id, decision.reason, deps.clock().toISOString());
        await appendAudit(deps, c, principal, "SETTLEMENT_FAILED", latest.id, {
          reason: decision.reason,
          signature: body.observation.signature,
        });
      }
      throw new AppError("RECONCILE_REJECTED", 409, decision.reason);
    }
    if (decision.idempotent) {
      return c.json({ id: latest.id, status: latest.status, signature: body.observation.signature, idempotent: true });
    }
    await service.markSubmitted(latest.id, body.observation.signature, deps.clock().toISOString());
    await appendAudit(deps, c, principal, "SETTLEMENT_SUBMITTED", latest.id, {
      signature: body.observation.signature,
      resultHash: latest.resultHash,
    });
    const confirmed = await service.markConfirmed(latest.id, body.observation.slot, deps.clock().toISOString());
    await appendAudit(deps, c, principal, "SETTLEMENT_CONFIRMED", confirmed.id, {
      signature: body.observation.signature,
      resultHash: confirmed.resultHash,
      settlementHash: confirmed.settlementHash,
    });
    return c.json({ id: confirmed.id, status: confirmed.status, signature: body.observation.signature });
  });

  app.post("/settlements/:id/reconcile-claim", async (c) => {
    const principal = await authenticate(c);
    const service = requireSettlement(deps);
    const body = (await c.req.json()) as {
      entryId: string;
      observation: ClaimObservation;
      expectedContestPda: string;
      expectedMint: string;
      expectedVault: string;
    };
    const proof = await service.claimProof(c.req.param("id"), body.entryId);
    const decision = decideClaim({
      observation: body.observation,
      programId: deps.config.server.solana.escrowProgramId,
      expectedClaimant: proof.row.destinationWallet,
      expectedContestPda: body.expectedContestPda,
      expectedVersion: proof.settlement.settlementVersion,
      expectedEntryId: body.entryId,
      expectedAmount: proof.row.netPayoutBaseUnits,
      expectedMint: body.expectedMint,
      expectedVault: body.expectedVault,
      existingSignature: proof.row.claimSignature,
    });
    if (!decision.ok) {
      throw new AppError("RECONCILE_REJECTED", 409, decision.reason);
    }
    const row = await service.markClaimed(
      c.req.param("id"),
      body.entryId,
      body.observation.signature,
      deps.clock().toISOString(),
    );
    await appendAudit(deps, c, principal, "PAYOUT_CLAIMED", body.entryId, {
      signature: body.observation.signature,
      amountBaseUnits: row.netPayoutBaseUnits,
      settlementId: c.req.param("id"),
      resultHash: proof.settlement.resultHash,
    });
    return c.json({
      entryId: row.entryId,
      claimStatus: row.claimStatus,
      claimSignature: row.claimSignature,
      explorerUrl: explorerUrl(row.claimSignature, deps.config.public.solanaCluster),
    });
  });
}

function requireSettlement(deps: AppDeps) {
  if (!deps.settlement) {
    throw new AppError("NOT_FOUND", 404, "Settlement is not available");
  }
  return deps.settlement;
}

function isApprovedStatus(status: string): boolean {
  return [
    "RESULT_APPROVED",
    "SETTLEMENT_APPROVED",
    "SETTLEMENT_PREPARED",
    "SETTLEMENT_SUBMITTED",
    "SETTLEMENT_CONFIRMED",
  ].includes(status);
}

function publicSettlement(settlement: {
  id: string;
  contestId: string;
  status: string;
  resultHash: string;
  settlementHash: string | null;
  merkleRoot: string | null;
  settlementVersion: number;
  approvedAt: string | null;
  commitSignature: string | null;
  confirmedAt: string | null;
  failureReason: string | null;
  totalPotBaseUnits: number;
  feeBaseUnits: number;
  totalPayoutBaseUnits: number;
}) {
  return {
    id: settlement.id,
    contestId: settlement.contestId,
    status: settlement.status,
    resultHash: settlement.resultHash,
    settlementHash: settlement.settlementHash,
    merkleRoot: settlement.merkleRoot,
    settlementVersion: settlement.settlementVersion,
    approvedAt: settlement.approvedAt,
    commitSignature: settlement.commitSignature,
    confirmedAt: settlement.confirmedAt,
    failureReason: settlement.failureReason,
    totals: {
      totalPotBaseUnits: settlement.totalPotBaseUnits,
      feeBaseUnits: settlement.feeBaseUnits,
      totalPayoutBaseUnits: settlement.totalPayoutBaseUnits,
    },
  };
}

function explorerUrl(signature: string | null, cluster: string): string | null {
  if (!signature) {
    return null;
  }
  const q = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${q}`;
}

async function appendAudit(
  deps: AppDeps,
  c: Context<AppEnv>,
  principal: Principal,
  action:
    | "RESULT_CALCULATED"
    | "RESULT_REVIEWED"
    | "RESULT_REJECTED"
    | "RESULT_APPROVED"
    | "SETTLEMENT_PREPARED"
    | "SETTLEMENT_SUBMITTED"
    | "SETTLEMENT_CONFIRMED"
    | "SETTLEMENT_FAILED"
    | "PAYOUT_CLAIMED",
  entityId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await deps.audit.append({
    action,
    actorAccountId: principal.accountId,
    actorWallet: principal.walletAddress,
    entityType: "SETTLEMENT",
    entityId,
    metadata,
    correlationId: c.get("requestId") ?? null,
    occurredAt: deps.clock(),
  });
}


function deriveClaimUiState(
  settlementStatus: string | null | undefined,
  row: { claimStatus: string; netPayoutBaseUnits: number } | null,
): string {
  if (!settlementStatus) return "pending_result";
  if (["RESULT_CALCULATED", "RESULT_REVIEWED"].includes(settlementStatus)) return "pending_result";
  if (["RESULT_APPROVED", "SETTLEMENT_APPROVED", "SETTLEMENT_PREPARED", "SETTLEMENT_SUBMITTED"].includes(settlementStatus)) {
    return "prize_settlement_pending";
  }
  if (settlementStatus === "SETTLEMENT_FAILED") return "failed";
  if (settlementStatus !== "SETTLEMENT_CONFIRMED") return "idle";
  if (!row) return "idle";
  if (row.claimStatus === "CLAIMED") return "confirmed";
  if (row.claimStatus === "SUBMITTED") return "confirming";
  if (row.claimStatus === "FAILED") return "failed";
  if (row.netPayoutBaseUnits <= 0) return "idle";
  return "claimable";
}

function settlementStages(status: string | null, claimStatus: string | null): string[] {
  const stages = ["MATCH FINAL", "Result Processing", "Results Verified", "Prize Committed", "Claim Available"];
  if (!status) return ["MATCH FINAL", "Result Processing"];
  if (["RESULT_CALCULATED", "RESULT_REVIEWED"].includes(status)) return stages.slice(0, 2);
  if (["RESULT_APPROVED", "SETTLEMENT_APPROVED"].includes(status)) return stages.slice(0, 3);
  if (["SETTLEMENT_PREPARED", "SETTLEMENT_SUBMITTED"].includes(status)) return stages.slice(0, 4);
  if (status === "SETTLEMENT_CONFIRMED") {
    if (claimStatus === "CLAIMED") return [...stages, "Prize Claimed"];
    return stages;
  }
  return stages.slice(0, 1);
}
