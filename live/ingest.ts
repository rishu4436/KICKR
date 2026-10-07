import type { Logger } from "../shared/logger.js";
import type { RequestContext } from "../auth/types.js";
import type { SportmonksClient } from "../sports/sportmonks-provider.js";
import {
  normalizeSportmonksFixtureEvents,
  type NormalizedEventDraft,
} from "../sports/normalize.js";
import type { LiveScoringPipeline, LivePipelineStore } from "./pipeline.js";
import type { LiveMetrics } from "./metrics.js";
import { transition } from "../domain/state-machine.js";
import type { MatchState } from "../domain/state-machine.js";
import type { ProviderIdMap } from "../sports/id-map.js";
import { extractSportmonksLineups, syncProviderLineups } from "./lineup-sync.js";
import {
  extractShotOnTargetTotals,
  synthesizeShotOnTargetEvents,
  SHOT_ON_TARGET_STAT,
  type PlayerStatObservationStore,
  InMemoryPlayerStatObservationStore,
} from "../sports/shot-synthesis.js";
import {
  isProviderFinalState,
  pollIntervalMsForStateId,
  POLL_INTERVAL_MS,
} from "../sports/poll-schedule.js";

/**
 * Polling ingestion worker. Idempotent. Bounded retries, timeout via client,
 * structured logs. Provider failure must not corrupt existing events.
 *
 * Phase 18C: when liveFixtureId is set, poll exactly that Sportmonks fixture.
 * Adaptive intervals: INPLAY 10s, HT/breaks 30s, PREMATCH 60s, FINAL stop HF.
 * Shot-on-target synthesis from durable player_stat_observations.
 */

export interface IngestWorkerOptions {
  pollIntervalMs: number;
  maxRetries: number;
  backoffMs: number;
  logger: Logger;
  clock: () => Date;
  /** Exactly one Sportmonks fixture when APP_MODE=LIVE. */
  liveFixtureId?: string | null;
  observationStore?: PlayerStatObservationStore;
}

export interface IngestWorker {
  start(): void;
  stop(): void;
  pollOnce(): Promise<void>;
  ingestNormalizedDrafts(
    drafts: NormalizedEventDraft[],
    matchId: string,
    ctx: RequestContext,
  ): Promise<void>;
  applyProviderFinal(matchId: string, ctx: RequestContext): Promise<MatchState[]>;
  syncLineupsForFixture(
    matchId: string,
    externalFixtureId: string,
    fixture: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<void>;
  /** Current adaptive interval (ms) or null when FINAL stopped HF polling. */
  currentPollIntervalMs(): number | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createIngestWorker(
  client: SportmonksClient | null,
  pipeline: LiveScoringPipeline,
  store: LivePipelineStore,
  idMap: ProviderIdMap,
  metrics: LiveMetrics,
  options: IngestWorkerOptions,
): IngestWorker {
  let timer: NodeJS.Timeout | null = null;
  let stopped = true;
  let inFlight = false;
  let adaptiveIntervalMs: number | null = options.pollIntervalMs;
  let highFrequencyStopped = false;
  const liveFixtureId = options.liveFixtureId?.trim() || null;
  const observations: PlayerStatObservationStore =
    options.observationStore ?? new InMemoryPlayerStatObservationStore();

  async function syncLineupsForFixture(
    matchId: string,
    externalFixtureId: string,
    fixture: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<void> {
    const rows = extractSportmonksLineups(fixture);
    const existingSquad = await store.listSquad(matchId);
    const players = await store.listPlayers();
    const synced = syncProviderLineups({
      provider: "sportmonks",
      matchId,
      externalFixtureId,
      rows,
      idMap,
      existingSquad,
      players,
      nowIso: ctx.now.toISOString(),
    });
    for (const row of synced.upserts) {
      await store.upsertSquadRow(row);
    }
    for (const unresolved of synced.unresolved) {
      metrics.recordUnresolvedPlayer();
      if (store.recordUnresolved) {
        await store.recordUnresolved({
          id: unresolved.id,
          provider: unresolved.provider,
          providerEventId: `lineup:${unresolved.externalPlayerId}`,
          matchId: unresolved.matchId,
          externalFixtureId: unresolved.externalFixtureId,
          externalPlayerId: unresolved.externalPlayerId,
          externalTeamId: unresolved.externalTeamId,
          reason: unresolved.reason,
          rawPayload: unresolved.rawPayload,
          createdAt: unresolved.createdAt,
        });
      }
    }
  }

  async function synthesizeShots(
    matchId: string,
    fixture: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<void> {
    const fixtureId = String(fixture.id ?? "");
    const totals = extractShotOnTargetTotals(fixture);
    const kickoffAt = typeof fixture.starting_at === "string" ? fixture.starting_at : null;
    let sequenceBase = (await store.listEvents(matchId)).length;
    for (const row of totals) {
      const prev = await observations.getObservation(fixtureId, row.playerId, SHOT_ON_TARGET_STAT);
      const previousTotal = prev?.observedTotal ?? 0;
      const { drafts, nextObservedTotal } = synthesizeShotOnTargetEvents({
        fixtureId,
        playerId: row.playerId,
        teamId: row.teamId,
        observedTotal: row.total,
        previousTotal,
        kickoffAt,
        nowIso: ctx.now.toISOString(),
        sequenceBase,
      });
      if (drafts.length > 0) {
        await ingestNormalizedDrafts(drafts, matchId, ctx);
        sequenceBase += drafts.length;
      }
      if (nextObservedTotal !== previousTotal || !prev) {
        await observations.upsertObservation({
          fixtureId,
          playerId: row.playerId,
          statType: SHOT_ON_TARGET_STAT,
          observedTotal: nextObservedTotal,
          updatedAt: ctx.now.toISOString(),
        });
      }
    }
  }

  async function ingestFixture(
    fixture: Record<string, unknown>,
    ctx: RequestContext,
  ): Promise<number | null> {
    const fixtureId = String(fixture.id ?? "");
    if (liveFixtureId && fixtureId !== liveFixtureId) {
      return adaptiveIntervalMs;
    }
    const matchId = idMap.get("sportmonks", "fixture", fixtureId);
    if (!matchId) {
      metrics.recordUnresolvedPlayer();
      if (store.recordUnresolved) {
        await store.recordUnresolved({
          id: crypto.randomUUID(),
          provider: "sportmonks",
          providerEventId: `fixture:${fixtureId}`,
          matchId: null,
          externalFixtureId: fixtureId,
          externalPlayerId: null,
          externalTeamId: null,
          reason: "unresolved_fixture",
          rawPayload: fixture,
          createdAt: ctx.now.toISOString(),
        });
      }
      return pollIntervalMsForStateId(
        typeof fixture.state_id === "number" ? fixture.state_id : null,
      );
    }
    await syncLineupsForFixture(matchId, fixtureId, fixture, ctx);
    const kickoffAt = typeof fixture.starting_at === "string" ? fixture.starting_at : null;
    const drafts = normalizeSportmonksFixtureEvents({
      id: fixtureId,
      events: Array.isArray(fixture.events) ? (fixture.events as Array<Record<string, unknown>>) : [],
      timeline: Array.isArray(fixture.timeline)
        ? (fixture.timeline as Array<Record<string, unknown>>)
        : [],
      starting_at: kickoffAt ?? undefined,
    });
    for (const draft of drafts) {
      draft.metadata = {
        ...draft.metadata,
        providerPolledAt: ctx.now.toISOString(),
        ingestedAt: ctx.now.toISOString(),
      };
    }
    await ingestNormalizedDrafts(drafts, matchId, ctx);
    await synthesizeShots(matchId, fixture, ctx);

    const stateId = fixture.state_id;
    if (isProviderFinalState(stateId)) {
      await applyProviderFinal(matchId, ctx);
    }
    return pollIntervalMsForStateId(typeof stateId === "number" ? stateId : null);
  }

  async function pollOnce(): Promise<void> {
    if (inFlight) {
      return;
    }
    inFlight = true;
    metrics.recordPollAttempt();
    const ctx: RequestContext = { now: options.clock(), correlationId: `ingest-${Date.now()}` };
    try {
      if (!client || !client.configured) {
        options.logger.warn(
          { liveProviderConfigured: false, missing: "SPORTS_API_KEY" },
          "live ingest skipped: provider not configured",
        );
        return;
      }
      if (highFrequencyStopped && liveFixtureId) {
        options.logger.info(
          { liveFixtureId, poll: "stopped" },
          "live ingest high-frequency polling stopped (FINAL)",
        );
        return;
      }
      const started = Date.now();
      let payload: unknown;
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          if (liveFixtureId) {
            payload = await client.getConfiguredFixture(liveFixtureId);
          } else {
            payload = await client.getInplayFixtures();
          }
          break;
        } catch (error) {
          metrics.recordProviderError();
          const status =
            error && typeof error === "object" && "status" in error
              ? (error as { status?: number }).status
              : undefined;
          options.logger.error(
            {
              attempt,
              status,
              message: error instanceof Error ? error.message : "poll failed",
              rateLimited: status === 429,
            },
            "provider poll failed",
          );
          if (attempt >= options.maxRetries) {
            // Back off harder on rate limit.
            if (status === 429) {
              adaptiveIntervalMs = Math.max(
                adaptiveIntervalMs ?? POLL_INTERVAL_MS.BREAK,
                POLL_INTERVAL_MS.BREAK * 2,
              );
            }
            return;
          }
          await sleep(options.backoffMs * attempt);
        }
      }
      metrics.recordLatency(Date.now() - started);
      const fixtures = extractFixtures(payload);
      if (liveFixtureId && fixtures.length === 0) {
        options.logger.error(
          { liveFixtureId, reason: "wrong_or_missing_fixture" },
          "LIVE_FIXTURE_ID returned no fixture payload",
        );
        metrics.recordProviderError();
        return;
      }
      if (liveFixtureId && fixtures.length > 1) {
        // Configured fixture endpoint should return one; refuse silent multi-match.
        options.logger.error(
          { liveFixtureId, count: fixtures.length },
          "LIVE mode expects exactly one fixture",
        );
      }
      let nextInterval: number | null = adaptiveIntervalMs;
      for (const fixture of fixtures) {
        if (liveFixtureId && String(fixture.id ?? "") !== liveFixtureId) {
          continue;
        }
        nextInterval = await ingestFixture(fixture, ctx);
      }
      adaptiveIntervalMs = nextInterval;
      if (nextInterval === null) {
        highFrequencyStopped = true;
      }
      metrics.recordPollSuccess(ctx.now, 0);
    } finally {
      inFlight = false;
    }
  }

  async function ingestNormalizedDrafts(
    drafts: NormalizedEventDraft[],
    matchId: string,
    ctx: RequestContext,
  ): Promise<void> {
    // Strict provider chronological order: sort_order then sequence then id.
    const ordered = drafts.slice().sort((a, b) => {
      const sa =
        typeof a.metadata.sortOrder === "number"
          ? a.metadata.sortOrder
          : Number.MAX_SAFE_INTEGER;
      const sb =
        typeof b.metadata.sortOrder === "number"
          ? b.metadata.sortOrder
          : Number.MAX_SAFE_INTEGER;
      if (sa !== sb) return sa - sb;
      return a.sequence - b.sequence || a.providerEventId.localeCompare(b.providerEventId);
    });
    for (const draft of ordered) {
      let supersedes: string | null = null;
      let unresolvedCorrection = false;
      const isCorrection =
        draft.eventType === "VAR_REVERSAL" ||
        draft.correctionType === "VAR_REVERSAL" ||
        draft.correctionType === "PROVIDER_CORRECTION";
      if (isCorrection) {
        const linked = await resolveCorrectionTarget(matchId, draft);
        supersedes = linked.supersedesEventId;
        unresolvedCorrection = linked.unresolved;
      }
      const result = await pipeline.acceptNormalized(
        { ...draft, sequence: draft.sequence },
        { matchId, supersedesEventId: supersedes, ctx },
      );
      if (unresolvedCorrection && result.event) {
        metrics.recordUnresolvedPlayer();
      }
      // Disallowed goal also invalidates derived assist (+ conceded companion).
      if (
        result.event &&
        supersedes &&
        (draft.eventType === "VAR_REVERSAL" || draft.correctionType === "VAR_REVERSAL")
      ) {
        await supersedeDerivedFromGoal(matchId, supersedes, draft, ctx);
      }
    }
  }

  async function supersedeDerivedFromGoal(
    matchId: string,
    goalEventId: string,
    correctionDraft: NormalizedEventDraft,
    ctx: RequestContext,
  ): Promise<void> {
    const goal = await store.findEventByProvider(
      correctionDraft.provider,
      correctionDraft.relatedProviderEventId ?? "",
    );
    // Prefer looking up the superseded goal by event id.
    const events = await store.listEvents(matchId);
    const goalRow = events.find((e) => e.eventId === goalEventId) ?? goal;
    if (!goalRow || goalRow.eventType !== "GOAL") {
      return;
    }
    for (const suffix of [":assist", ":conceded"]) {
      const derivedProviderId = `${goalRow.providerEventId}${suffix}`;
      const derived = await store.findEventByProvider(goalRow.provider, derivedProviderId);
      if (!derived || derived.supersedesEventId) {
        // If already effective but we need a superseding correction row:
      }
      if (!derived) continue;
      const alreadySuperseded = events.some((e) => e.supersedesEventId === derived.eventId);
      if (alreadySuperseded) continue;
      const correction: NormalizedEventDraft = {
        ...correctionDraft,
        providerEventId: `${correctionDraft.providerEventId}${suffix}`,
        eventType: "VAR_REVERSAL",
        correctionType: "VAR_REVERSAL",
        relatedProviderEventId: derivedProviderId,
        primaryExternalPlayerId: null,
        secondaryExternalPlayerId: null,
        requiresPrimaryPlayer: false,
        derivedAssist: undefined,
        metadata: {
          ...correctionDraft.metadata,
          derivedSupersede: suffix.slice(1),
          parentGoalProviderEventId: goalRow.providerEventId,
        },
      };
      await pipeline.acceptNormalized(correction, {
        matchId,
        supersedesEventId: derived.eventId,
        ctx,
      });
    }
  }

  /**
   * Prefer explicit related provider event ids. Never blindly reverse the latest
   * goal by the same player when the payload does not establish the link.
   * Do NOT rely on rescinded boolean for VAR correctness.
   */
  async function resolveCorrectionTarget(
    _matchId: string,
    draft: NormalizedEventDraft,
  ): Promise<{ supersedesEventId: string | null; unresolved: boolean }> {
    void _matchId;
    if (draft.relatedProviderEventId) {
      const related = await store.findEventByProvider(draft.provider, draft.relatedProviderEventId);
      if (related) {
        return { supersedesEventId: related.eventId, unresolved: false };
      }
      return { supersedesEventId: null, unresolved: true };
    }
    return { supersedesEventId: null, unresolved: true };
  }

  async function applyProviderFinal(matchId: string, ctx: RequestContext): Promise<MatchState[]> {
    const match = await store.getMatch(matchId);
    if (!match) {
      return [];
    }
    const applied: MatchState[] = [];
    let status = match.status;
    const path: MatchState[] = [];
    if (status === "LIVE" || status === "HALFTIME") {
      path.push("FULL_TIME", "DATA_FINALIZING");
    } else if (status === "FULL_TIME") {
      path.push("DATA_FINALIZING");
    }
    for (const to of path) {
      try {
        transition("MATCH", status, to);
        const updated = await store.applyMatchTransition(matchId, to, ctx.now);
        status = updated.status;
        applied.push(status);
      } catch {
        break;
      }
    }
    if (applied.includes("DATA_FINALIZING") || status === "DATA_FINALIZING") {
      await pipeline.recomputeMatch(matchId, ctx);
    }
    return applied;
  }

  return {
    async pollOnce() {
      await pollOnce();
    },
    ingestNormalizedDrafts,
    applyProviderFinal,
    syncLineupsForFixture,
    currentPollIntervalMs() {
      return highFrequencyStopped ? null : adaptiveIntervalMs;
    },
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      highFrequencyStopped = false;
      const tick = () => {
        void pollOnce().finally(() => {
          if (stopped) return;
          const delay = adaptiveIntervalMs;
          if (delay === null) {
            highFrequencyStopped = true;
            options.logger.info(
              { liveFixtureId, reason: "FINAL" },
              "stopped high-frequency Sportmonks polling",
            );
            return;
          }
          timer = setTimeout(tick, delay);
        });
      };
      tick();
    },
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}

function extractFixtures(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const data = (payload as { data?: unknown }).data;
  if (Array.isArray(data)) {
    return data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
  }
  if (data && typeof data === "object") {
    return [data as Record<string, unknown>];
  }
  return [];
}
