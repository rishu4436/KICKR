import type { AuditStore } from "../audit/types.js";
import { auditResult, type AuditQuery } from "../audit/query.js";
import type { AuthService } from "../auth/service.js";
import { contestAcceptsNewEntry } from "../contests/types.js";
import type { ContestService } from "../contests/service.js";
import type { FootballService } from "../football/service.js";
import type { LiveScoringService } from "../live/service.js";
import type { SnapshotStore } from "../live/snapshot.js";
import type { Permission } from "../rbac/permissions.js";
import { hasOpsCapability } from "../rbac/ops-capabilities.js";
import type { SettlementService } from "../settlement/service.js";
import { AppError } from "../shared/errors.js";

export interface OpsReadDeps {
  auth: AuthService;
  audit: AuditStore;
  football: FootballService;
  contests: ContestService;
  live?: LiveScoringService;
  settlement?: SettlementService;
  snapshots?: SnapshotStore;
  liveProviderConfigured: boolean;
  providerName: string;
  cluster: string;
  counters?: Record<string, number> | null;
}

type Gate = ReadonlySet<Permission>;

function allowed(gate: Gate, capability: Parameters<typeof hasOpsCapability>[1]): boolean {
  return hasOpsCapability(gate, capability);
}

function hidden() {
  return { available: false as const, reason: "not_permitted" as const };
}

function missing(reason: "unavailable" | "stale") {
  return { available: false as const, reason };
}

const BLOCKED_SETTLEMENT = new Set(["RESULT_REJECTED", "SETTLEMENT_FAILED", "VOIDED"]);
const PENDING_SETTLEMENT = new Set([
  "RESULT_CALCULATED",
  "RESULT_REVIEWED",
  "RESULT_APPROVED",
  "SETTLEMENT_APPROVED",
  "SETTLEMENT_PREPARED",
  "SETTLEMENT_SUBMITTED",
]);

export function claimView(status: string, signature: string | null, claimedAt: string | null, cluster: string) {
  const displayStatus =
    status === "SUBMITTED" ? "CONFIRMING" : status === "CLAIMED" ? "CLAIMED" : status === "FAILED" ? "FAILED" : status;
  const finalized = status === "CLAIMED" && claimedAt !== null;
  return {
    rawStatus: status,
    displayStatus,
    signature,
    claimedAt,
    finalized,
    reconciliation: finalized ? "finalized" : status === "FAILED" ? "failed" : status === "SUBMITTED" ? "not_finalized" : "not_submitted",
    paid: finalized,
    note: "A signature is not paid until finalized reconciliation.",
    explorerUrl: signature ? explorerUrl(signature, cluster) : null,
    proof: null,
    proofAvailable: false,
    proofReason: "owner_scoped",
  };
}

function explorerUrl(signature: string, cluster: string): string {
  const query = cluster === "devnet" ? "?cluster=devnet" : "";
  return `https://explorer.solana.com/tx/${signature}${query}`;
}

function settlementView(row: {
  id: string;
  contestId: string;
  matchId: string;
  status: string;
  resultHash: string;
  settlementHash: string | null;
  merkleRoot: string | null;
  settlementVersion: number;
  commitSignature: string | null;
  confirmedAt: string | null;
  failureReason: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
}) {
  const stage =
    row.status === "RESULT_CALCULATED"
      ? "calculated"
      : row.status === "RESULT_REVIEWED"
        ? "reviewed"
        : row.status === "RESULT_APPROVED" || row.status === "SETTLEMENT_APPROVED"
          ? "approved"
          : row.status;
  return {
    id: row.id,
    contestId: row.contestId,
    matchId: row.matchId,
    status: row.status,
    stage,
    resultHash: row.resultHash,
    settlementHash: row.settlementHash,
    merkleRoot: row.merkleRoot,
    settlementVersion: row.settlementVersion,
    commitmentSignature: row.commitSignature,
    confirmedAt: row.confirmedAt,
    failureReason: row.failureReason,
    approvedBy: row.approvedBy,
    approvedAt: row.approvedAt,
    reconciliation:
      row.status === "SETTLEMENT_CONFIRMED"
        ? "finalized"
        : row.status === "SETTLEMENT_FAILED"
          ? "failed"
          : "not_finalized",
    runSettlement: "not_granted" as const,
    custody: "none" as const,
    note: "Display only. RUN_SETTLEMENT is granted to nobody. This record is not a custodial USDC balance.",
  };
}

async function settlementRows(deps: OpsReadDeps) {
  if (!deps.settlement) {
    return { settlements: null, rows: null };
  }
  const [settlements, rows] = await Promise.all([
    deps.settlement.listAll(),
    deps.settlement.listAllRows(),
  ]);
  return { settlements, rows };
}

export async function buildOverview(deps: OpsReadDeps, gate: Gate, now: Date) {
  const matches = allowed(gate, "READ_MATCHES") ? await deps.football.listMatches() : null;
  const contests = allowed(gate, "READ_CONTESTS") ? await deps.contests.listAllContests() : null;
  const settlementData =
    allowed(gate, "READ_SETTLEMENTS") || allowed(gate, "READ_CLAIMS") ? await settlementRows(deps) : { settlements: null, rows: null };
  const diagnostics = allowed(gate, "READ_DIAGNOSTICS") ? diagnosticsSnapshot(deps, now) : null;
  const denials = allowed(gate, "READ_AUDIT")
    ? await deps.audit.query({ limit: 100, permissionDenialsOnly: true })
    : null;

  const liveMatches = matches?.filter((match) => match.status === "LIVE" || match.status === "HALFTIME").length ?? null;
  const ingest = !allowed(gate, "READ_MATCHES")
    ? hidden()
    : deps.live
      ? {
          available: true as const,
          liveStatusMatches: liveMatches,
          providerConfigured: deps.liveProviderConfigured,
          state: deps.liveProviderConfigured ? "observed" : "stale",
          lastSuccessfulPollAt: deps.live.metrics.snapshot().lastSuccessfulPollAt,
        }
      : { ...missing(deps.liveProviderConfigured ? "unavailable" : "stale"), liveStatusMatches: liveMatches };

  let health: "ok" | "degraded" | "unknown" = "unknown";
  if (diagnostics?.available) {
    const errors = diagnostics.metrics?.providerErrors ?? 0;
    const ingestState = "state" in ingest ? ingest.state : null;
    health = errors > 0 || ingestState === "stale" ? "degraded" : "ok";
  }

  const settlementCounts = settlementData.settlements
    ? {
        available: true as const,
        blocked: settlementData.settlements.filter((row) => BLOCKED_SETTLEMENT.has(String(row.status))).length,
        pending: settlementData.settlements.filter((row) => PENDING_SETTLEMENT.has(String(row.status))).length,
        confirmed: settlementData.settlements.filter((row) => row.status === "SETTLEMENT_CONFIRMED").length,
      }
    : allowed(gate, "READ_SETTLEMENTS")
      ? missing("unavailable")
      : hidden();

  const claimCounts = settlementData.rows
    ? {
        available: true as const,
        pending: settlementData.rows.filter((row) => row.claimStatus === "SUBMITTED").length,
        confirmed: settlementData.rows.filter((row) => row.claimStatus === "CLAIMED").length,
        failed: settlementData.rows.filter((row) => row.claimStatus === "FAILED").length,
      }
    : allowed(gate, "READ_CLAIMS")
      ? missing("unavailable")
      : hidden();

  return {
    health,
    generatedAt: now.toISOString(),
    matchesIngesting: ingest,
    contests: contests
      ? {
          available: true as const,
          total: contests.length,
          joinable: contests.filter((contest) => contestAcceptsNewEntry(contest.status)).length,
          notJoinable: contests.filter((contest) => !contestAcceptsNewEntry(contest.status)).length,
        }
      : allowed(gate, "READ_CONTESTS")
        ? missing("unavailable")
        : hidden(),
    settlements: settlementCounts,
    claims: claimCounts,
    operationalErrors: diagnostics
      ? diagnostics.available
        ? { available: true as const, providerErrors: diagnostics.metrics?.providerErrors ?? null }
        : missing(diagnostics.reason === "stale" ? "stale" : "unavailable")
      : allowed(gate, "READ_DIAGNOSTICS")
        ? missing("unavailable")
        : hidden(),
    suspiciousAuthz: denials
      ? { available: true as const, permissionDenials: denials.length, capped: denials.length === 100 }
      : allowed(gate, "READ_AUDIT")
        ? missing("unavailable")
        : hidden(),
    runSettlement: "not_granted" as const,
  };
}

function diagnosticsSnapshot(deps: OpsReadDeps, _now: Date) {
  if (!deps.live) {
    return {
      available: false as const,
      reason: deps.liveProviderConfigured ? ("unavailable" as const) : ("stale" as const),
      metrics: null,
      unresolved: null,
    };
  }
  const metrics = deps.live.metrics.snapshot();
  return {
    available: true as const,
    reason: null,
    provider: deps.providerName,
    liveProviderConfigured: deps.liveProviderConfigured,
    metrics,
    unresolved: deps.live.pipeline.getUnresolved().slice(0, 100),
    note: "Phase 5 diagnostics. No second scoring or ingest implementation.",
  };
}

export async function buildDiagnostics(deps: OpsReadDeps, now: Date) {
  return {
    generatedAt: now.toISOString(),
    ...diagnosticsSnapshot(deps, now),
    counters: deps.counters ?? null,
    dependencies: {
      note: "Process liveness is /health. Readiness is /ready. A provider blip is dependency health, not process death.",
    },
    featureFlags: { available: false as const, reason: "no_flag_store" },
  };
}

export async function buildProviderConfig(deps: OpsReadDeps) {
  return {
    provider: deps.providerName,
    liveProviderConfigured: deps.liveProviderConfigured,
    featureFlags: { available: false as const, reason: "no_flag_store" },
    secrets: "not_returned" as const,
    mutable: false,
  };
}

export async function listOpsMatches(deps: OpsReadDeps) {
  const matches = await deps.football.listMatches();
  return {
    matches: await Promise.all(matches.map(async (match) => ({
      ...match,
      freshness: await matchFreshness(deps, match.id, match.status),
    }))),
  };
}

async function matchFreshness(deps: OpsReadDeps, matchId: string, status: string) {
  if (!deps.live) {
    return missing(status === "LIVE" || status === "HALFTIME" ? "stale" : "unavailable");
  }
  const cached = await deps.live.cache.readMatch(matchId);
  if (!cached) {
    return missing(status === "LIVE" || status === "HALFTIME" ? "stale" : "unavailable");
  }
  return {
    available: true as const,
    state: cached.freshness,
    updatedAt: cached.updatedAt,
    lastEventAt: cached.lastEventAt,
    eventCount: cached.eventCount,
  };
}

export async function buildMatchDetail(deps: OpsReadDeps, matchId: string) {
  const match = await deps.football.getMatch(matchId);
  if (!match) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  const events = await deps.football.listStoredEvents(matchId);
  const squad = await deps.football.getSquad(matchId);
  const snapshots = deps.snapshots ? await deps.snapshots.listByMatch(matchId) : null;
  const unresolved = deps.live
    ? deps.live.pipeline.getUnresolved().filter((row) => row.matchId === matchId)
    : null;
  const corrections = (events ?? []).filter((event) => event.supersedesEventId || event.correctionType);
  return {
    match,
    provider: match.dataSource,
    freshness: await matchFreshness(deps, matchId, match.status),
    events: events
      ? events.map((event) => ({
          eventId: event.eventId,
          provider: event.provider,
          providerEventId: event.providerEventId,
          sequence: event.sequence,
          timestamp: event.timestamp,
          matchMinute: event.matchMinute,
          period: event.period,
          eventType: event.eventType,
          primaryPlayerId: event.primaryPlayerId,
          secondaryPlayerId: event.secondaryPlayerId,
          teamId: event.teamId,
          supersedesEventId: event.supersedesEventId,
          correctionType: event.correctionType ?? null,
        }))
      : [],
    lineup: squad,
    scoring: deps.live ? await matchFreshness(deps, matchId, match.status) : missing("unavailable"),
    snapshots: snapshots
      ? snapshots.map((row) => ({
          id: row.id,
          entryId: row.entryId,
          contestId: row.contestId,
          status: row.status,
          rulesetName: row.rulesetName,
          rulesetVersion: row.rulesetVersion,
          approvedAt: row.approvedAt,
        }))
      : missing("unavailable"),
    dataErrors: {
      corrections: corrections.length,
      unresolved: unresolved ? { available: true as const, count: unresolved.length, rows: unresolved } : missing("unavailable"),
    },
    mutable: false,
    note: "Append-only events are shown as stored. No manual scoring and no event mutation.",
  };
}

export async function listOpsContests(deps: OpsReadDeps) {
  const contests = await deps.contests.listAllContests();
  const health = await deps.contests.depositHealth();
  return {
    pendingReservations: health.pendingReservations,
    contests: contests.map(contestSummary),
    joinable: contests.filter((contest) => contestAcceptsNewEntry(contest.status)).map(contestSummary),
    closed: contests.filter((contest) => !contestAcceptsNewEntry(contest.status)).map(contestSummary),
  };
}

function contestSummary(contest: Awaited<ReturnType<ContestService["listAllContests"]>>[number]) {
  return {
    id: contest.id,
    matchId: contest.matchId,
    templateId: contest.templateId,
    templateCode: contest.rulesSnapshot.templateCode,
    contestType: contest.contestType,
    status: contest.status,
    joinable: contestAcceptsNewEntry(contest.status),
    capacity: contest.capacity,
    filledCount: contest.filledCount,
    confirmedSeats: contest.confirmedCount,
    pendingReservations: Math.max(0, contest.filledCount - contest.confirmedCount),
    entryFeeBaseUnits: contest.entryFeeBaseUnits,
    currency: contest.currency,
    lockTime: contest.rulesSnapshot.lockTime,
    lockedAt: contest.lockedAt,
    settlementStatus: null as string | null,
  };
}

export async function buildContestDetail(deps: OpsReadDeps, contestId: string) {
  const contest = (await deps.contests.listAllContests()).find((row) => row.id === contestId);
  if (!contest) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  const settlement = deps.settlement ? await deps.settlement.getStatus(contestId) : null;
  const summary = contestSummary(contest);
  summary.settlementStatus = settlement ? String(settlement.status) : null;
  return {
    contest: summary,
    settlement: settlement ? settlementView(settlement) : null,
    join: "not_available_in_control_center" as const,
  };
}

export async function listOpsEntries(deps: OpsReadDeps, contestId: string | undefined) {
  const contests = await deps.contests.listAllContests();
  const selected = contestId ? contests.filter((contest) => contest.id === contestId) : contests;
  if (contestId && selected.length === 0) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  const entries = [];
  for (const contest of selected) {
    const rows = await deps.contests.listDeposits(contest.id);
    for (const entry of rows) {
      entries.push(entryView(entry));
    }
  }
  return { entries };
}

function entryView(entry: {
  id: string;
  contestId: string;
  wallet: string;
  teamVersionId: string;
  status: string;
  confirmationStatus: string;
  seatNumber: number;
  joinedAt: string;
  createdAt: string;
}) {
  return {
    entryId: entry.id,
    contestId: entry.contestId,
    wallet: entry.wallet,
    teamVersionId: entry.teamVersionId,
    status: entry.status,
    confirmationStatus: entry.confirmationStatus,
    seatNumber: entry.seatNumber,
    joinedAt: entry.joinedAt,
    createdAt: entry.createdAt,
    authMode: "solana_wallet" as const,
    lastActivityAt: null,
    lastActivityAvailable: false,
    revoked: null,
  };
}

export async function buildEntryDetail(deps: OpsReadDeps, entryId: string, contestId: string) {
  const entry = await deps.contests.findEntry(entryId);
  if (!entry || entry.contestId !== contestId) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  return { entry: entryView(entry) };
}

export async function listOpsSettlements(deps: OpsReadDeps) {
  const data = await settlementRows(deps);
  if (!data.settlements || !data.rows) {
    return missing("unavailable");
  }
  return {
    available: true as const,
    runSettlement: "not_granted" as const,
    settlements: data.settlements.map((row) => ({
      ...settlementView(row),
      claims: data.rows
        .filter((claim) => claim.settlementId === row.id)
        .map((claim) => claimView(claim.claimStatus, claim.claimSignature, claim.claimedAt, deps.cluster)),
    })),
  };
}

export async function buildSettlementDetail(deps: OpsReadDeps, settlementId: string) {
  if (!deps.settlement) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  const settlement = await deps.settlement.getById(settlementId);
  if (!settlement) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  const rows = await deps.settlement.getLeaderboard(settlementId);
  return {
    settlement: settlementView(settlement),
    claims: rows.map((row) => ({
      entryId: row.entryId,
      claimant: row.destinationWallet,
      payoutBaseUnits: row.netPayoutBaseUnits,
      ...claimView(row.claimStatus, row.claimSignature, row.claimedAt, deps.cluster),
    })),
  };
}

export async function listOpsClaims(deps: OpsReadDeps) {
  const data = await settlementRows(deps);
  if (!data.rows || !data.settlements) {
    return missing("unavailable");
  }
  const byId = new Map(data.settlements.map((row) => [row.id, row]));
  return {
    available: true as const,
    claims: data.rows.map((row) => {
      const settlement = byId.get(row.settlementId);
      return {
        entryId: row.entryId,
        settlementId: row.settlementId,
        contestId: row.contestId,
        claimant: row.destinationWallet,
        payoutBaseUnits: row.netPayoutBaseUnits,
        settlementStatus: settlement ? String(settlement.status) : null,
        ...claimView(row.claimStatus, row.claimSignature, row.claimedAt, deps.cluster),
      };
    }),
  };
}

export async function queryOpsAudit(audit: AuditStore, filter: AuditQuery) {
  const events = await audit.query(filter);
  return {
    events: events.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt.toISOString(),
      actorAccountId: event.actorAccountId,
      actorWallet: event.actorWallet,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      correlationId: event.correlationId,
      metadata: event.metadata,
      result: auditResult(event),
    })),
  };
}
