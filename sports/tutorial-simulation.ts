/**
 * Tutorial Match simulation runner (Phase 18D.1).
 * Session-auth player path — DEMO provider matches only.
 * Never operates on Sportmonks / LIVE fixtures.
 */
import type { AuditStore } from "../audit/types.js";
import type { RequestContext } from "../auth/types.js";
import type { FootballService } from "../football/service.js";
import type { FootballStore } from "../football/store.js";
import type { LiveScoringService } from "../live/service.js";
import type { ContestService } from "../contests/service.js";
import type { RedisClient } from "../redis/client.js";
import { cacheKey, deserializeCacheValue, serializeCacheValue } from "../redis/keys.js";
import { AppError } from "../shared/errors.js";
import { DEMO_PROVIDER_NAME } from "./demo-provider.js";
import { buildDemoSingleMatchCatalog } from "./demo-provider.js";
import {
  buildTutorialScriptSteps,
  footballScoreAfterSequence,
  materializeTutorialEvents,
  phaseAtElapsed,
  TUTORIAL_MATCH_ID,
  type TutorialPhase,
  type TutorialScriptStep,
  expectedTutorialDurationMs,
} from "./tutorial-script.js";
import type { MatchState } from "../domain/state-machine.js";
import { FREE_TEMPLATES } from "../contests/free/catalog.js";
import { newId } from "../shared/ids.js";

export interface TutorialSimState {
  matchId: string;
  runId: string;
  startedAt: string;
  appliedThrough: number;
  completed: boolean;
  phase: TutorialPhase;
}

export interface TutorialSimDeps {
  football: FootballService;
  footballStore: FootballStore;
  contests: ContestService;
  live: LiveScoringService;
  audit: AuditStore;
  redis: RedisClient | null;
  clock: () => Date;
  environment: string;
}

const MEMORY_SIM = new Map<string, TutorialSimState>();

function simKey(env: string, matchId: string): string {
  return cacheKey(env, "tutorial-sim", matchId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 48) || "tutorial");
}

async function loadState(deps: TutorialSimDeps, matchId: string): Promise<TutorialSimState | null> {
  if (deps.redis) {
    try {
      const raw = await deps.redis.get(simKey(deps.environment, matchId));
      if (raw) return deserializeCacheValue<TutorialSimState>(raw);
    } catch {
      /* fall through to memory */
    }
  }
  return MEMORY_SIM.get(matchId) ?? null;
}

async function saveState(deps: TutorialSimDeps, state: TutorialSimState): Promise<void> {
  MEMORY_SIM.set(state.matchId, state);
  if (deps.redis) {
    try {
      await deps.redis.set(simKey(deps.environment, state.matchId), serializeCacheValue(state), 60 * 60 * 6);
    } catch {
      /* memory remains authoritative for this process */
    }
  }
}

async function clearState(deps: TutorialSimDeps, matchId: string): Promise<void> {
  MEMORY_SIM.delete(matchId);
  if (deps.redis) {
    try {
      await deps.redis.del(simKey(deps.environment, matchId));
    } catch {
      /* ignore */
    }
  }
}

async function assertTutorialMatch(deps: TutorialSimDeps, matchId: string): Promise<void> {
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  if (match.dataSource.provider !== DEMO_PROVIDER_NAME) {
    throw new AppError(
      "TUTORIAL_REFUSED",
      403,
      "Tutorial simulation is only available on the Tutorial Match (simulated). Sportmonks fixtures cannot invoke the simulator.",
    );
  }
  const allowed = new Set(buildDemoSingleMatchCatalog().matches.map((m) => m.id));
  allowed.add(TUTORIAL_MATCH_ID);
  if (!allowed.has(matchId)) {
    throw new AppError("TUTORIAL_REFUSED", 403, "Not the Tutorial Match");
  }
}

export async function getTutorialMatchId(): Promise<string> {
  const catalog = buildDemoSingleMatchCatalog();
  return catalog.matches[0]?.id ?? TUTORIAL_MATCH_ID;
}

export async function startTutorialSimulation(
  deps: TutorialSimDeps,
  matchId: string,
): Promise<TutorialSimState> {
  await assertTutorialMatch(deps, matchId);
  const existing = await loadState(deps, matchId);
  if (existing && !existing.completed) {
    return tickTutorialSimulation(deps, matchId);
  }
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  if (match.status !== "LINEUPS_AVAILABLE" && match.status !== "LOCKED") {
    throw new AppError(
      "VALIDATION",
      409,
      `Tutorial simulation requires LINEUPS_AVAILABLE (got ${match.status}). Use Reset Tutorial first.`,
    );
  }
  const runId = newId().replace(/-/g, "").slice(0, 12);
  const state: TutorialSimState = {
    matchId,
    runId,
    startedAt: deps.clock().toISOString(),
    appliedThrough: 0,
    completed: false,
    phase: "PRE",
  };
  await saveState(deps, state);
  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `tutorial-start-${matchId}-${runId}`,
  };
  await deps.audit.append({
    action: "DEMO_MATCH_ADVANCED",
    occurredAt: ctx.now,
    entityType: "MATCH",
    entityId: matchId,
    metadata: {
      tutorial: true,
      simulated: true,
      action: "start",
      runId,
      notSportmonks: true,
      source: DEMO_PROVIDER_NAME,
      runSettlement: false,
    },
    actorAccountId: null,
    actorWallet: null,
    correlationId: ctx.correlationId,
  });
  return tickTutorialSimulation(deps, matchId);
}

async function applyStateStep(
  deps: TutorialSimDeps,
  matchId: string,
  to: MatchState,
  ctx: RequestContext,
): Promise<void> {
  const match = await deps.football.getMatch(matchId);
  if (!match) return;
  if (match.status === to) return;
  // Walk forward along legal edges when needed.
  const path: MatchState[] = ["LOCKED", "LIVE", "FULL_TIME", "DATA_FINALIZING", "FINAL"];
  const currentIdx = path.indexOf(match.status as MatchState);
  const targetIdx = path.indexOf(to);
  if (match.status === "LINEUPS_AVAILABLE" && to === "LOCKED") {
    await deps.football.applyMatchTransition(matchId, "LOCKED", ctx);
    await deps.contests.lockContestsForMatch(matchId, ctx);
    return;
  }
  if (currentIdx < 0 && match.status === "LINEUPS_AVAILABLE") {
    await deps.football.applyMatchTransition(matchId, "LOCKED", ctx);
    await deps.contests.lockContestsForMatch(matchId, ctx);
    if (to === "LOCKED") return;
  }
  let idx = path.indexOf((await deps.football.getMatch(matchId))!.status as MatchState);
  const end = targetIdx >= 0 ? targetIdx : idx;
  while (idx >= 0 && idx < end) {
    const next = path[idx + 1]!;
    await deps.football.applyMatchTransition(matchId, next, ctx);
    if (next === "LOCKED") {
      await deps.contests.lockContestsForMatch(matchId, ctx);
    }
    idx += 1;
  }
}

export async function tickTutorialSimulation(
  deps: TutorialSimDeps,
  matchId: string,
): Promise<TutorialSimState> {
  await assertTutorialMatch(deps, matchId);
  const state = await loadState(deps, matchId);
  if (!state) {
    throw new AppError("VALIDATION", 409, "Tutorial simulation has not been started");
  }
  if (state.completed) return state;

  const elapsed = Math.max(0, deps.clock().getTime() - new Date(state.startedAt).getTime());
  const steps = buildTutorialScriptSteps().filter((s) => s.atMs <= elapsed && s.sequence > state!.appliedThrough);
  if (steps.length === 0) {
    state.phase = phaseAtElapsed(elapsed);
    await saveState(deps, state);
    return state;
  }

  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `tutorial-tick-${matchId}-${state.runId}-${state.appliedThrough}`,
  };

  let maxSeq = state.appliedThrough;
  for (const step of steps) {
    if (step.kind === "STATE" && step.toStatus) {
      await applyStateStep(deps, matchId, step.toStatus, ctx);
    }
    if (step.kind === "EVENT") {
      const events = materializeTutorialEvents({
        matchId,
        runId: state.runId,
        throughSequence: step.sequence,
        createdAt: deps.clock().toISOString(),
      });
      const ev = events.find((e) => e.sequence === step.sequence);
      if (ev) {
        await deps.footballStore.insertEvent({
          eventId: ev.eventId,
          matchId: ev.matchId,
          provider: ev.provider,
          providerEventId: ev.providerEventId,
          sequence: ev.sequence,
          timestamp: ev.timestamp,
          matchMinute: ev.matchMinute,
          period: ev.period,
          eventType: ev.eventType,
          primaryPlayerId: ev.primaryPlayerId,
          secondaryPlayerId: ev.secondaryPlayerId,
          teamId: ev.teamId,
          metadata: ev.metadata,
          supersedesEventId: ev.supersedesEventId,
          createdAt: ev.createdAt,
          correctionType: ev.eventType === "VAR_REVERSAL" ? "VAR_REVERSAL" : null,
        });
      }
    }
    maxSeq = Math.max(maxSeq, step.sequence);
  }

  if (steps.some((s) => s.kind === "EVENT")) {
    await deps.live.pipeline.rebuildFromEvents(matchId, ctx);
  }

  const last = steps[steps.length - 1]!;
  if (last.toStatus === "FINAL" || last.sequence >= buildTutorialScriptSteps().slice(-1)[0]!.sequence) {
    // Finalize FREE contests (no settlement).
    try {
      const match = await deps.football.getMatch(matchId);
      if (match?.status === "FINAL") {
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
        for (const [contestId, scores] of byContest) {
          if (!contestId || scores.length === 0) continue;
          let contest;
          try {
            contest = await deps.contests.getContest(contestId);
          } catch {
            continue;
          }
          if (!contest || contest.contestKind !== "FREE") continue;
          const existing = await deps.contests.getFreeResult(contestId);
          if (existing) continue;
          await deps.contests.finalizeFreeResult(contestId, scores, ctx);
        }
      }
    } catch {
      /* finalize best-effort; status endpoint still reports FT */
    }
    state.completed = true;
  }

  state.appliedThrough = maxSeq;
  state.phase = phaseAtElapsed(elapsed);
  await saveState(deps, state);
  return state;
}

export async function resetTutorialMatch(deps: TutorialSimDeps, matchId: string): Promise<{ matchId: string; status: string }> {
  await assertTutorialMatch(deps, matchId);
  await clearState(deps, matchId);
  const catalog = buildDemoSingleMatchCatalog();
  // Force LINEUPS_AVAILABLE + wipe demo events for this match (store-level tutorial reset).
  await deps.footballStore.resetTutorialMatch?.(matchId, catalog);
  if (!deps.footballStore.resetTutorialMatch) {
    // Fallback: re-upsert catalog (memory replaces; PG needs resetTutorialMatch).
    await deps.footballStore.upsertCatalog(catalog);
  }
  for (const template of FREE_TEMPLATES) {
    await deps.contests.ensureOpenContest(matchId, template.id, {
      now: deps.clock(),
      correlationId: `tutorial-reset-${matchId}`,
    });
  }
  const match = await deps.football.getMatch(matchId);
  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `tutorial-reset-${matchId}`,
  };
  await deps.audit.append({
    action: "DEMO_MATCH_SEEDED",
    occurredAt: ctx.now,
    entityType: "MATCH",
    entityId: matchId,
    metadata: {
      tutorial: true,
      simulated: true,
      action: "reset",
      notSportmonks: true,
      source: DEMO_PROVIDER_NAME,
      runSettlement: false,
    },
    actorAccountId: null,
    actorWallet: null,
    correlationId: ctx.correlationId,
  });
  return { matchId, status: match?.status ?? "LINEUPS_AVAILABLE" };
}

export interface TutorialStatusView {
  matchId: string;
  simulated: true;
  tutorial: true;
  running: boolean;
  completed: boolean;
  runId: string | null;
  phase: TutorialPhase;
  elapsedMs: number;
  durationMs: number;
  appliedThrough: number;
  footballScore: { home: number; away: number };
  matchMinute: number;
  period: string;
  matchStatus: string;
  recentSteps: TutorialScriptStep[];
  coachTips: Array<{ id: string; title: string; body: string }>;
}

export async function getTutorialStatus(deps: TutorialSimDeps, matchId: string): Promise<TutorialStatusView> {
  await assertTutorialMatch(deps, matchId);
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  let state = await loadState(deps, matchId);
  if (state && !state.completed) {
    state = await tickTutorialSimulation(deps, matchId);
  }
  const elapsed = state ? Math.max(0, deps.clock().getTime() - new Date(state.startedAt).getTime()) : 0;
  const applied = state?.appliedThrough ?? 0;
  const steps = buildTutorialScriptSteps().filter((s) => s.sequence <= applied);
  const latest = steps[steps.length - 1];
  const tips = steps
    .filter((s) => s.coachTip)
    .map((s) => s.coachTip!)
    .filter((t, i, arr) => arr.findIndex((x) => x.id === t.id) === i);
  return {
    matchId,
    simulated: true,
    tutorial: true,
    running: Boolean(state && !state.completed),
    completed: Boolean(state?.completed || match.status === "FINAL"),
    runId: state?.runId ?? null,
    phase: state?.phase ?? (match.status === "LINEUPS_AVAILABLE" ? "PRE" : phaseAtElapsed(elapsed)),
    elapsedMs: elapsed,
    durationMs: expectedTutorialDurationMs(),
    appliedThrough: applied,
    footballScore: footballScoreAfterSequence(applied),
    matchMinute: latest?.matchMinute ?? 0,
    period: latest?.period ?? "1",
    matchStatus: match.status,
    recentSteps: steps.slice(-8),
    coachTips: tips,
  };
}
