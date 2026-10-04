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
    const settlement = await service.prepare(c.req.param("id"), deps.clock().toISOString());
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
