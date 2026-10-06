/**
 * Clean FREE contest E2E harness (dev-only).
 *
 * Forward-only match lifecycle. Real scoring + free finalize paths.
 * No reverse match edges. No manual production-table SQL edits.
 * Blocked when NODE_ENV=production or SPORTS_DATA_PROVIDER≠local-dev.
 */
import type { AuditStore } from "../../audit/types.js";
import type { RequestContext } from "../../auth/types.js";
import type { FootballService } from "../../football/service.js";
import type { FootballStore } from "../../football/store.js";
import type { LiveScoringService } from "../../live/service.js";
import type { MatchState } from "../../domain/state-machine.js";
import {
  buildEphemeralLocalDevMatch,
  buildLateLocalDevEvents,
  pickDiverseLocalDevXi,
} from "../../sports/local-dev-provider.js";
import { AppError } from "../../shared/errors.js";
import type { ContestService } from "../service.js";
import { assertFreeDevHarnessAllowed, isFreeDevHarnessAllowed } from "./dev-gate.js";
import type { LocalDevScoringActorRegistry } from "./local-dev-scoring-actor.js";
import type { FreeContestResult } from "./results.js";

/** Legal forward path from LINEUPS_AVAILABLE through FINAL (no reverse edges). */
export const E2E_MATCH_FORWARD_PATH: readonly MatchState[] = [
  "LOCKED",
  "LIVE",
  "FULL_TIME",
  "DATA_FINALIZING",
  "FINAL",
] as const;

export interface DevE2eDeps {
  nodeEnv: string;
  sportsDataProvider: string;
  football: FootballService;
  footballStore: FootballStore;
  contests: ContestService;
  live: LiveScoringService;
  audit: AuditStore;
  scoringActors: LocalDevScoringActorRegistry;
  clock: () => Date;
}

export function harnessAllowed(deps: Pick<DevE2eDeps, "nodeEnv" | "sportsDataProvider">): boolean {
  return isFreeDevHarnessAllowed(deps);
}

export async function seedFreshLocalDevMatch(
  deps: DevE2eDeps,
  seed?: number,
): Promise<{ matchId: string; label: string; status: string }> {
  assertFreeDevHarnessAllowed(deps);
  const built = buildEphemeralLocalDevMatch(seed ?? Date.now());
  await deps.footballStore.upsertCatalog(built.catalog);
  const ctx: RequestContext = { now: deps.clock(), correlationId: `dev-e2e-seed-${built.matchId}` };
  await deps.audit.append({
    action: "LOCAL_DEV_MATCH_SEEDED",
    occurredAt: ctx.now,
    entityType: "MATCH",
    entityId: built.matchId,
    metadata: {
      label: built.label,
      status: "LINEUPS_AVAILABLE",
      notSportmonks: true,
      source: "local-dev",
    },
    actorAccountId: null,
    actorWallet: null,
    correlationId: ctx.correlationId,
  });
  const match = await deps.football.getMatch(built.matchId);
  if (!match || match.status !== "LINEUPS_AVAILABLE") {
    throw new AppError("INTERNAL", 500, "Failed to seed LOCAL_DEV match", { expose: false });
  }
  return { matchId: built.matchId, label: built.label, status: match.status };
}

export async function advanceMatchForward(
  deps: DevE2eDeps,
  matchId: string,
  to: MatchState,
): Promise<{ matchId: string; status: string }> {
  assertFreeDevHarnessAllowed(deps);
  const ctx: RequestContext = { now: deps.clock(), correlationId: `dev-e2e-advance-${matchId}-${to}` };
  const before = await deps.football.getMatch(matchId);
  if (!before) throw new AppError("NOT_FOUND", 404, "Match not found");
  const updated = await deps.football.applyMatchTransition(matchId, to, ctx);
  if (to === "LOCKED") {
    await deps.contests.lockContestsForMatch(matchId, ctx);
  }
  await deps.audit.append({
    action: "LOCAL_DEV_MATCH_ADVANCED",
    occurredAt: ctx.now,
    entityType: "MATCH",
    entityId: matchId,
    metadata: {
      from: before.status,
      to: updated.status,
      notSportmonks: true,
      source: "local-dev",
    },
    actorAccountId: null,
    actorWallet: null,
    correlationId: ctx.correlationId,
  });
  return { matchId, status: updated.status };
}

export async function advanceMatchAlongPath(
  deps: DevE2eDeps,
  matchId: string,
  until: MatchState,
): Promise<{ matchId: string; status: string; steps: string[] }> {
  assertFreeDevHarnessAllowed(deps);
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
  if (!E2E_MATCH_FORWARD_PATH.includes(until) && until !== "LINEUPS_AVAILABLE") {
    throw new AppError("VALIDATION", 400, `Unsupported target status ${until}`);
  }
  const steps: string[] = [];
  let current = match.status as MatchState;
  if (current === until) {
    return { matchId, status: current, steps };
  }
  for (const next of E2E_MATCH_FORWARD_PATH) {
    if (current === until) break;
    // Only take the next legal edge from current.
    const need = next;
    if (current === "LINEUPS_AVAILABLE" && need === "LOCKED") {
      const advanced = await advanceMatchForward(deps, matchId, need);
      current = advanced.status as MatchState;
      steps.push(current);
    } else if (current === "LOCKED" && need === "LIVE") {
      const advanced = await advanceMatchForward(deps, matchId, need);
      current = advanced.status as MatchState;
      steps.push(current);
    } else if (current === "LIVE" && need === "FULL_TIME") {
      const advanced = await advanceMatchForward(deps, matchId, need);
      current = advanced.status as MatchState;
      steps.push(current);
    } else if (current === "FULL_TIME" && need === "DATA_FINALIZING") {
      const advanced = await advanceMatchForward(deps, matchId, need);
      current = advanced.status as MatchState;
      steps.push(current);
    } else if (current === "DATA_FINALIZING" && need === "FINAL") {
      const advanced = await advanceMatchForward(deps, matchId, need);
      current = advanced.status as MatchState;
      steps.push(current);
    }
  }
  if (current !== until) {
    throw new AppError(
      "ILLEGAL_TRANSITION",
      409,
      `Could not advance match from ${match.status} to ${until} (stopped at ${current})`,
    );
  }
  return { matchId, status: current, steps };
}


export async function appendLateLocalDevEvents(
  deps: DevE2eDeps,
  matchId: string,
): Promise<{ inserted: number }> {
  assertFreeDevHarnessAllowed(deps);
  const events = buildLateLocalDevEvents(matchId);
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
  return { inserted };
}

export async function rebuildLiveScores(
  deps: DevE2eDeps,
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
  assertFreeDevHarnessAllowed(deps);
  const ctx: RequestContext = { now: deps.clock(), correlationId: `dev-e2e-score-${matchId}` };
  const match = await deps.football.getMatch(matchId);
  if (!match) throw new AppError("NOT_FOUND", 404, "Match not found for scoring");
  // Force the real pipeline path (bypass live leaderboard cache) so late events re-score.
  const rebuilt = await deps.live.pipeline.rebuildFromEvents(matchId, ctx);
  return { leaderboard: rebuilt.leaderboard };
}

export async function finalizeFreeFromLiveScores(
  deps: DevE2eDeps,
  contestId: string,
  scoringActorAccountId: string,
): Promise<FreeContestResult> {
  assertFreeDevHarnessAllowed(deps);
  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `dev-e2e-finalize-${contestId}`,
  };
  await deps.scoringActors.assertCanFinalize(scoringActorAccountId, contestId, ctx);
  const contest = await deps.contests.getContest(contestId);
  const scored = await rebuildLiveScores(deps, contest.matchId);
  const forContest = scored.leaderboard.filter((row) => row.contestId === contestId);
  if (forContest.length === 0) {
    throw new AppError("VALIDATION", 400, "No scored entries for contest — rebuild scoring after joins");
  }
  // Prefer teamVersionId from leaderboard; fall back via entry list if blank (cache path).
  const entries = await deps.contests.listDeposits(contestId);
  const byEntry = new Map(entries.map((e) => [e.id, e]));
  const scores = forContest.map((row) => ({
    entryId: row.entryId,
    wallet: row.wallet,
    teamVersionId: row.teamVersionId || byEntry.get(row.entryId)?.teamVersionId || "",
    finalScoreMilliPoints: row.milliPoints,
  }));
  for (const row of scores) {
    if (!row.teamVersionId) {
      throw new AppError("INTERNAL", 500, "Missing teamVersionId on scored entry", { expose: false });
    }
  }
  return deps.contests.finalizeFreeResult(contestId, scores, ctx);
}

export { pickDiverseLocalDevXi, buildEphemeralLocalDevMatch, buildLateLocalDevEvents };
