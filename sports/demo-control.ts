/**
 * DEMO-only match control: advance seeded demo matches and inject scoring waves.
 * Enabled when (SPORTS_PROVIDER=DEMO or APP_MODE=DEMO|DUAL) and DEMO_CONTROL_TOKEN is set
 * and the caller presents a matching x-demo-control-token header.
 * Never operates on LIVE/Sportmonks matches. Never grants RUN_SETTLEMENT.
 */
import { timingSafeEqual } from "node:crypto";
import type { AuditStore } from "../audit/types.js";
import type { RequestContext } from "../auth/types.js";
import type { FootballService } from "../football/service.js";
import type { FootballStore } from "../football/store.js";
import type { LiveScoringService } from "../live/service.js";
import type { MatchState } from "../domain/state-machine.js";
import {
  buildEphemeralLocalDevMatch,
  buildLateLocalDevEvents,
  LOCAL_DEV_MATCH_UPCOMING,
} from "./local-dev-provider.js";
import { DEMO_PROVIDER_NAME } from "./demo-provider.js";
import { AppError } from "../shared/errors.js";
import type { ContestService } from "../contests/service.js";
import { FREE_TEMPLATES } from "../contests/free/catalog.js";

/** Legal forward path from LINEUPS_AVAILABLE through FINAL. */
export const DEMO_MATCH_FORWARD_PATH: readonly MatchState[] = [
  "LOCKED",
  "LIVE",
  "FULL_TIME",
  "DATA_FINALIZING",
  "FINAL",
] as const;

export interface DemoControlGate {
  sportsProvider: string;
  /** Raw configured token; empty/undefined means control is off. */
  demoControlToken: string | undefined | null;
  /** APP_MODE — DEMO and DUAL may enable control; LIVE never. */
  appMode?: "LIVE" | "DEMO" | "DUAL" | null;
}

export interface DemoControlDeps {
  football: FootballService;
  footballStore: FootballStore;
  contests: ContestService;
  live: LiveScoringService;
  audit: AuditStore;
  clock: () => Date;
}

export function isDemoControlConfigured(gate: DemoControlGate): boolean {
  const token = (gate.demoControlToken ?? "").trim();
  if (token.length < 16) return false;
  if (gate.appMode === "LIVE") return false;
  if (gate.appMode === "DEMO" || gate.appMode === "DUAL") return true;
  const provider = gate.sportsProvider.trim().toLowerCase().replace(/_/g, "-");
  return provider === "demo";
}

export function assertDemoControlToken(
  gate: DemoControlGate,
  provided: string | undefined | null,
): void {
  if (!isDemoControlConfigured(gate)) {
    throw new AppError(
      "DEMO_CONTROL_DISABLED",
      403,
      gate.appMode === "LIVE"
        ? "Demo match control is unavailable in LIVE mode"
        : "Demo match control requires APP_MODE=DEMO|DUAL (or SPORTS_PROVIDER=DEMO) and DEMO_CONTROL_TOKEN",
    );
  }
  const expected = (gate.demoControlToken ?? "").trim();
  if (expected.length < 16) {
    throw new AppError(
      "DEMO_CONTROL_DISABLED",
      403,
      "Demo match control is disabled (DEMO_CONTROL_TOKEN not configured)",
    );
  }
  const got = (provided ?? "").trim();
  if (got.length !== expected.length) {
    throw new AppError("DEMO_CONTROL_FORBIDDEN", 403, "Invalid demo control token");
  }
  const a = Buffer.from(got, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new AppError("DEMO_CONTROL_FORBIDDEN", 403, "Invalid demo control token");
  }
}

async function assertDemoMatch(deps: DemoControlDeps, matchId: string): Promise<void> {
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  if (match.dataSource.provider !== DEMO_PROVIDER_NAME) {
    throw new AppError(
      "DEMO_CONTROL_DISABLED",
      403,
      "Demo match control refuses LIVE/Sportmonks fixtures (DEMO DATA only)",
    );
  }
}

function demoEvents(matchId: string) {
  return buildLateLocalDevEvents(matchId).map((event) => ({
    ...event,
    provider: DEMO_PROVIDER_NAME,
    metadata: {
      ...event.metadata,
      label: "DEMO DATA scoring wave — fictional, not a live feed",
      source: DEMO_PROVIDER_NAME,
      notSportmonks: true,
      demoData: true,
    },
  }));
}

export async function demoAdvanceMatchForward(
  deps: DemoControlDeps,
  matchId: string,
  to: MatchState,
): Promise<{ matchId: string; status: string }> {
  await assertDemoMatch(deps, matchId);
  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `demo-control-advance-${matchId}-${to}`,
  };
  const before = await deps.football.getMatch(matchId);
  if (!before) throw new AppError("NOT_FOUND", 404, "Match not found");
  const updated = await deps.football.applyMatchTransition(matchId, to, ctx);
  if (to === "LOCKED") {
    await deps.contests.lockContestsForMatch(matchId, ctx);
  }
  await deps.audit.append({
    action: "DEMO_MATCH_ADVANCED",
    occurredAt: ctx.now,
    entityType: "MATCH",
    entityId: matchId,
    metadata: {
      from: before.status,
      to: updated.status,
      notSportmonks: true,
      source: DEMO_PROVIDER_NAME,
      demoData: true,
      runSettlement: false,
    },
    actorAccountId: null,
    actorWallet: null,
    correlationId: ctx.correlationId,
  });
  return { matchId, status: updated.status };
}

export async function demoAdvanceMatchAlongPath(
  deps: DemoControlDeps,
  matchId: string,
  until: MatchState,
): Promise<{ matchId: string; status: string; steps: string[] }> {
  await assertDemoMatch(deps, matchId);
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  if (!DEMO_MATCH_FORWARD_PATH.includes(until) && until !== "LINEUPS_AVAILABLE") {
    throw new AppError("VALIDATION", 400, `Unsupported target status ${until}`);
  }
  const steps: string[] = [];
  let current = match.status as MatchState;
  if (current === until) {
    return { matchId, status: current, steps };
  }
  const edges: Array<[MatchState, MatchState]> = [
    ["LINEUPS_AVAILABLE", "LOCKED"],
    ["LOCKED", "LIVE"],
    ["LIVE", "FULL_TIME"],
    ["FULL_TIME", "DATA_FINALIZING"],
    ["DATA_FINALIZING", "FINAL"],
  ];
  for (const [from, to] of edges) {
    if (current === until) break;
    if (current === from) {
      const advanced = await demoAdvanceMatchForward(deps, matchId, to);
      current = advanced.status as MatchState;
      steps.push(current);
    }
  }
  if (current !== until) {
    throw new AppError(
      "ILLEGAL_TRANSITION",
      409,
      `Could not advance demo match from ${match.status} to ${until} (stopped at ${current})`,
    );
  }
  return { matchId, status: current, steps };
}

export async function demoInjectScoringWave(
  deps: DemoControlDeps,
  matchId: string,
): Promise<{ inserted: number }> {
  await assertDemoMatch(deps, matchId);
  const events = demoEvents(matchId);
  let inserted = 0;
  for (const event of events) {
    const result = await deps.footballStore.insertEvent({
      eventId: event.eventId,
      matchId: event.matchId,
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
      metadata: event.metadata,
      supersedesEventId: event.supersedesEventId,
      createdAt: event.createdAt,
    });
    if (result === "inserted") inserted += 1;
  }
  if (inserted > 0) {
    const ctx: RequestContext = {
      now: deps.clock(),
      correlationId: `demo-control-wave-${matchId}`,
    };
    await deps.live.pipeline.rebuildFromEvents(matchId, ctx);
    await deps.audit.append({
      action: "DEMO_SCORING_WAVE",
      occurredAt: ctx.now,
      entityType: "MATCH",
      entityId: matchId,
      metadata: {
        inserted,
        notSportmonks: true,
        source: DEMO_PROVIDER_NAME,
        demoData: true,
        runSettlement: false,
      },
      actorAccountId: null,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });
  }
  return { inserted };
}

export async function demoRebuildScores(
  deps: DemoControlDeps,
  matchId: string,
): Promise<{
  leaderboard: Array<{
    entryId: string;
    contestId: string;
    teamVersionId: string;
    wallet: string;
    milliPoints: number;
    rank: number;
  }>;
}> {
  await assertDemoMatch(deps, matchId);
  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `demo-control-score-${matchId}`,
  };
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found for scoring");
  const rebuilt = await deps.live.pipeline.rebuildFromEvents(matchId, ctx);
  await deps.audit.append({
    action: "DEMO_SCORE_REBUILD",
    occurredAt: ctx.now,
    entityType: "MATCH",
    entityId: matchId,
    metadata: {
      rows: rebuilt.leaderboard.length,
      notSportmonks: true,
      source: DEMO_PROVIDER_NAME,
      demoData: true,
      runSettlement: false,
    },
    actorAccountId: null,
    actorWallet: null,
    correlationId: ctx.correlationId,
  });
  return {
    leaderboard: rebuilt.leaderboard.map((row) => ({
      entryId: row.entryId,
      contestId: row.contestId,
      teamVersionId: row.teamVersionId,
      wallet: row.wallet,
      milliPoints: row.milliPoints,
      rank: row.rank,
    })),
  };
}

export async function demoFinalizeFreeContests(
  deps: DemoControlDeps,
  matchId: string,
): Promise<{
  finalized: Array<{ contestId: string; rows: number }>;
  runSettlement: false;
}> {
  await assertDemoMatch(deps, matchId);
  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `demo-control-finalize-${matchId}`,
  };
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  if (match.status !== "FINAL") {
    throw new AppError("VALIDATION", 409, "Demo free finalize requires match status FINAL");
  }
  const rebuilt = await deps.live.pipeline.rebuildFromEvents(matchId, ctx);
  const byContest = new Map<
    string,
    Array<{ entryId: string; wallet: string; teamVersionId: string; finalScoreMilliPoints: number }>
  >();
  for (const row of rebuilt.leaderboard) {
    const list = byContest.get(row.contestId) ?? [];
    list.push({
      entryId: row.entryId,
      wallet: row.wallet,
      teamVersionId: row.teamVersionId,
      finalScoreMilliPoints: row.milliPoints,
    });
    byContest.set(row.contestId, list);
  }
  const finalized: Array<{ contestId: string; rows: number }> = [];
  for (const [contestId, scores] of byContest) {
    if (!contestId || scores.length === 0) continue;
    let contest;
    try {
      contest = await deps.contests.getContest(contestId);
    } catch {
      // Leaderboard may include non-contest rows; skip unknown ids.
      continue;
    }
    if (!contest || contest.contestKind !== "FREE") continue;
    const existing = await deps.contests.getFreeResult(contestId);
    if (existing) {
      finalized.push({ contestId, rows: existing.rows.length });
      continue;
    }
    const result = await deps.contests.finalizeFreeResult(contestId, scores, ctx);
    await deps.audit.append({
      action: "DEMO_FREE_FINALIZE",
      occurredAt: ctx.now,
      entityType: "CONTEST",
      entityId: contestId,
      metadata: {
        matchId,
        rows: result.rows.length,
        notSportmonks: true,
        source: DEMO_PROVIDER_NAME,
        demoData: true,
        runSettlement: false,
        note: "Token-gated DEMO control finalize. Not RUN_SETTLEMENT.",
      },
      actorAccountId: null,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });
    finalized.push({ contestId, rows: result.rows.length });
  }
  return { finalized, runSettlement: false };
}


export async function seedFreshDemoMatch(
  deps: DemoControlDeps,
  seed?: number,
): Promise<{ matchId: string; label: string; status: string }> {
  const built = buildEphemeralLocalDevMatch(seed ?? Date.now());
  // Relabel as DEMO DATA (not LOCAL_DEV) for public-demo control.
  const catalog = {
    ...built.catalog,
    matches: built.catalog.matches.map((m) => ({
      ...m,
      competition: "DEMO Cup",
      dataSource: {
        provider: DEMO_PROVIDER_NAME,
        label: "DEMO DATA — fictional clubs/players, not Sportmonks, not a live feed",
        fetchedAt: m.dataSource.fetchedAt,
      },
    })),
    events: built.catalog.events.map((e) => ({
      ...e,
      provider: DEMO_PROVIDER_NAME,
      metadata: {
        ...e.metadata,
        label: "DEMO DATA event — fictional, not a live feed",
        source: DEMO_PROVIDER_NAME,
        notSportmonks: true,
        demoData: true,
      },
    })),
  };
  await deps.footballStore.upsertCatalog(catalog);
  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `demo-control-seed-${built.matchId}`,
  };
  // Ensure FREE contests for the new match
  for (const template of FREE_TEMPLATES) {
    await deps.contests.ensureOpenContest(built.matchId, template.id, ctx);
  }
  await deps.audit.append({
    action: "DEMO_MATCH_SEEDED",
    occurredAt: ctx.now,
    entityType: "MATCH",
    entityId: built.matchId,
    metadata: {
      label: built.label.replace(/LOCAL_DEV/g, "DEMO"),
      status: "LINEUPS_AVAILABLE",
      notSportmonks: true,
      source: DEMO_PROVIDER_NAME,
      demoData: true,
      runSettlement: false,
    },
    actorAccountId: null,
    actorWallet: null,
    correlationId: ctx.correlationId,
  });
  const match = await deps.football.getMatch(built.matchId);
  if (!match || match.status !== "LINEUPS_AVAILABLE") {
    throw new AppError("INTERNAL", 500, "Failed to seed DEMO match", { expose: false });
  }
  return {
    matchId: built.matchId,
    label: built.label.replace(/LOCAL_DEV/g, "DEMO"),
    status: match.status,
  };
}

/** Default seeded upcoming DEMO match id (same UUID as LOCAL_DEV catalog upcoming). */
export const DEMO_SEEDED_UPCOMING_MATCH_ID = LOCAL_DEV_MATCH_UPCOMING;
