import type { Logger } from "../shared/logger.js";
import type { RequestContext } from "../auth/types.js";
import type { SportmonksClient } from "../sports/sportmonks-provider.js";
import {
  normalizeSportmonksEvent,
  sportmonksFixtureToRawEvents,
  type NormalizedEventDraft,
} from "../sports/normalize.js";
import type { LiveScoringPipeline } from "./pipeline.js";
import type { LiveMetrics } from "./metrics.js";
import { transition } from "../domain/state-machine.js";
import type { MatchState } from "../domain/state-machine.js";
import type { LivePipelineStore } from "./pipeline.js";
import type { ProviderIdMap } from "../sports/id-map.js";

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
      let latestEventAge: number | null = null;
      for (const fixture of fixtures) {
        const fixtureId = String(fixture.id ?? "");
        const matchId = idMap.get("sportmonks", "fixture", fixtureId);
        if (!matchId) {
          continue;
        }
        const rawEvents = sportmonksFixtureToRawEvents({
          id: fixtureId,
          events: Array.isArray(fixture.events) ? (fixture.events as Array<Record<string, unknown>>) : [],
          timeline: Array.isArray(fixture.timeline)
            ? (fixture.timeline as Array<Record<string, unknown>>)
            : [],
          starting_at: typeof fixture.starting_at === "string" ? fixture.starting_at : undefined,
        });
        const drafts = rawEvents.map((raw, index) => normalizeSportmonksEvent(raw, index + 1));
        await ingestNormalizedDrafts(drafts, matchId, ctx);

        const stateId = fixture.state_id;
        if (isProviderFinal(stateId)) {
          await applyProviderFinal(matchId, ctx);
        }
        const last = drafts.at(-1);
        if (last?.timestamp) {
          const age = ctx.now.getTime() - Date.parse(last.timestamp);
          if (Number.isFinite(age)) {
            latestEventAge = latestEventAge === null ? age : Math.min(latestEventAge, age);
          }
        }
      }
      metrics.recordPollSuccess(ctx.now, latestEventAge);
    } finally {
      inFlight = false;
    }
  }

  async function ingestNormalizedDrafts(
    drafts: NormalizedEventDraft[],
    matchId: string,
    ctx: RequestContext,
  ): Promise<void> {
    // Order by sequence/minute but accept late/out-of-order arrivals without rewriting history.
    const ordered = drafts.slice().sort((a, b) => {
      const minuteA = a.matchMinute ?? 0;
      const minuteB = b.matchMinute ?? 0;
      return minuteA - minuteB || a.sequence - b.sequence || a.providerEventId.localeCompare(b.providerEventId);
    });
    for (const draft of ordered) {
      let supersedes: string | null = null;
      if (draft.eventType === "VAR_REVERSAL") {
        supersedes = await findGoalToReverse(matchId, draft);
      }
      await pipeline.acceptNormalized(
        { ...draft, sequence: draft.sequence },
        { matchId, supersedesEventId: supersedes, ctx },
      );
    }
  }

  async function findGoalToReverse(matchId: string, draft: NormalizedEventDraft): Promise<string | null> {
    const events = await store.listEvents(matchId);
    const playerId = draft.primaryExternalPlayerId
      ? idMap.get(draft.provider, "player", draft.primaryExternalPlayerId)
      : null;
    const goal = events
      .filter((event) => event.eventType === "GOAL")
      .filter((event) => !events.some((other) => other.supersedesEventId === event.eventId))
      .filter((event) => (playerId ? event.primaryPlayerId === playerId : true))
      .sort((a, b) => b.sequence - a.sequence)[0];
    return goal?.eventId ?? null;
  }

  async function applyProviderFinal(matchId: string, ctx: RequestContext): Promise<MatchState[]> {
    const match = await store.getMatch(matchId);
    if (!match) {
      return [];
    }
    const applied: MatchState[] = [];
    let status = match.status;
    // LIVE → FULL_TIME → DATA_FINALIZING. Do not settle. Do not force FINAL here.
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
  // Sportmonks FT / AET / FT_PEN common state ids include 5 (FT). Keep conservative.
  return stateId === 5 || stateId === 7 || stateId === 8;
}
