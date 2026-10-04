import type { Logger } from "../shared/logger.js";
import type { RequestContext } from "../auth/types.js";
import type { SportmonksClient } from "../sports/sportmonks-provider.js";
import {
  normalizeSportmonksEvent,
  sportmonksFixtureToRawEvents,
  type NormalizedEventDraft,
} from "../sports/normalize.js";
import type { LiveScoringPipeline, LivePipelineStore } from "./pipeline.js";
import type { LiveMetrics } from "./metrics.js";
import { transition } from "../domain/state-machine.js";
import type { MatchState } from "../domain/state-machine.js";
import type { ProviderIdMap } from "../sports/id-map.js";
import { extractSportmonksLineups, syncProviderLineups } from "./lineup-sync.js";

/**
 * Polling ingestion worker. Idempotent. Bounded retries, timeout via client,
 * structured logs. Provider failure must not corrupt existing events.
 */

export interface IngestWorkerOptions {
  pollIntervalMs: number;
  maxRetries: number;
  backoffMs: number;
  logger: Logger;
  clock: () => Date;
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
      const started = Date.now();
      let payload: unknown;
      let attempt = 0;
      while (true) {
        attempt += 1;
        try {
          payload = await client.getInplayFixtures();
          break;
        } catch (error) {
          metrics.recordProviderError();
          options.logger.error(
            {
              attempt,
              message: error instanceof Error ? error.message : "poll failed",
            },
            "provider poll failed",
          );
          if (attempt >= options.maxRetries) {
            return;
          }
          await sleep(options.backoffMs * attempt);
        }
      }
      metrics.recordLatency(Date.now() - started);
      const fixtures = extractFixtures(payload);
      const latestIngestLag: number | null = 0;
      for (const fixture of fixtures) {
        const fixtureId = String(fixture.id ?? "");
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
          continue;
        }
        await syncLineupsForFixture(matchId, fixtureId, fixture, ctx);
        const kickoffAt =
          typeof fixture.starting_at === "string" ? fixture.starting_at : null;
        const rawEvents = sportmonksFixtureToRawEvents({
          id: fixtureId,
          events: Array.isArray(fixture.events) ? (fixture.events as Array<Record<string, unknown>>) : [],
          timeline: Array.isArray(fixture.timeline)
            ? (fixture.timeline as Array<Record<string, unknown>>)
            : [],
          starting_at: kickoffAt ?? undefined,
        });
        const drafts = rawEvents.map((raw, index) =>
          normalizeSportmonksEvent(raw, index + 1, "v3", kickoffAt),
        );
        for (const draft of drafts) {
          draft.metadata = {
            ...draft.metadata,
            providerPolledAt: ctx.now.toISOString(),
            ingestedAt: ctx.now.toISOString(),
          };
        }
        await ingestNormalizedDrafts(drafts, matchId, ctx);

        const stateId = fixture.state_id;
        if (isProviderFinal(stateId)) {
          await applyProviderFinal(matchId, ctx);
        }
      }
      // Ingest lag is poll health, not kickoff age.
      metrics.recordPollSuccess(ctx.now, latestIngestLag);
    } finally {
      inFlight = false;
    }
  }

  async function ingestNormalizedDrafts(
    drafts: NormalizedEventDraft[],
    matchId: string,
    ctx: RequestContext,
  ): Promise<void> {
    const ordered = drafts.slice().sort((a, b) => {
      const minuteA = a.matchMinute ?? 0;
      const minuteB = b.matchMinute ?? 0;
      return minuteA - minuteB || a.sequence - b.sequence || a.providerEventId.localeCompare(b.providerEventId);
    });
    for (const draft of ordered) {
      let supersedes: string | null = null;
      let unresolvedCorrection = false;
      if (draft.eventType === "VAR_REVERSAL" || draft.correctionType === "VAR_REVERSAL") {
        const linked = await resolveCorrectionTarget(matchId, draft);
        supersedes = linked.supersedesEventId;
        unresolvedCorrection = linked.unresolved;
      }
      const result = await pipeline.acceptNormalized(
        { ...draft, sequence: draft.sequence },
        { matchId, supersedesEventId: supersedes, ctx },
      );
      if (unresolvedCorrection && result.event) {
        // Correction fact is stored; no silent reverse of an arbitrary goal.
        metrics.recordUnresolvedPlayer();
      }
    }
  }

  /**
   * Prefer explicit related provider event ids. Never blindly reverse the latest
   * goal by the same player when the payload does not establish the link.
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
    // No safe link established by the provider payload.
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
    start() {
      if (!stopped) {
        return;
      }
      stopped = false;
      const tick = () => {
        void pollOnce().finally(() => {
          if (!stopped) {
            timer = setTimeout(tick, options.pollIntervalMs);
          }
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

function isProviderFinal(stateId: unknown): boolean {
  return stateId === 5 || stateId === 7 || stateId === 8;
}
