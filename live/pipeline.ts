import type { AuditStore } from "../audit/types.js";
import { DEV_V1_RULESET, DEV_V1_SCALE } from "../domain/scoring/dev-v1.js";
import {
  calculatePlayerPoints,
  calculateTeamPoints,
  effectiveEvents,
  type ScoringEventInput,
} from "../domain/scoring/engine.js";
import type { ScoringEventType } from "../domain/scoring/events.js";
import type {
  FantasyTeamRecord,
  FantasyTeamVersionRecord,
  FootballStore,
  MatchRecord,
  PlayerRecord,
  SquadRecord,
  StoredMatchEvent,
} from "../football/store.js";
import type { ProviderIdMap } from "../sports/id-map.js";
import type { NormalizedEventDraft } from "../sports/normalize.js";
import { newId } from "../shared/ids.js";
import type { RequestContext } from "../auth/types.js";
import type { LiveFreshness, LiveScoreCache, MatchLiveScoreCache, TeamLiveScoreCache } from "./cache.js";
import type { LiveScoreHub, LiveScoreUpdate } from "./hub.js";
import { derivePitchStates, eligibleForGoalConceded, type LineupSeed } from "./lineup.js";
import type { LiveMetrics } from "./metrics.js";

export interface UnresolvedProviderEvent {
  id: string;
  provider: string;
  providerEventId: string;
  matchId: string | null;
  externalFixtureId: string | null;
  externalPlayerId: string | null;
  externalTeamId: string | null;
  reason: string;
  rawPayload: Record<string, unknown>;
  createdAt: string;
}

export interface LivePipelineStore extends FootballStore {
  insertEvent(event: StoredMatchEvent): Promise<"inserted" | "duplicate">;
  findEventByProvider(provider: string, providerEventId: string): Promise<StoredMatchEvent | null>;
  listTeamsByMatch(matchId: string): Promise<FantasyTeamRecord[]>;
  recordUnresolved?(row: UnresolvedProviderEvent): Promise<void>;
  listUnresolved?(matchId?: string): Promise<UnresolvedProviderEvent[]>;
}

export interface AcceptEventResult {
  status: "accepted" | "duplicate" | "unresolved_player" | "rejected";
  event: StoredMatchEvent | null;
  reason?: string;
  score?: RecomputeResult;
}

export interface RecomputeResult {
  matchId: string;
  freshness: LiveFreshness;
  playerScores: Array<{ playerId: string; baseMilliPoints: number }>;
  teamScores: TeamLiveScoreCache[];
  leaderboard: Array<{ teamId: string; accountId: string; milliPoints: number; rank: number }>;
  eventCount: number;
  lastEventAt: string | null;
  goalConcededDiagnostics: Array<{
    eventId: string;
    eligiblePlayerIds: string[];
    unresolved: boolean;
    reason: string | null;
  }>;
  updates: LiveScoreUpdate[];
}

function toScoringInput(event: StoredMatchEvent): ScoringEventInput {
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    primaryPlayerId: event.primaryPlayerId,
    secondaryPlayerId: event.secondaryPlayerId,
    supersedesEventId: event.supersedesEventId,
    sequence: event.sequence,
  };
}

function freshnessFor(match: MatchRecord, lastEventAt: string | null, now: Date): LiveFreshness {
  if (match.status === "FINAL" || match.status === "DATA_FINALIZING") {
    return "FINAL";
  }
  if (match.status === "LIVE" || match.status === "HALFTIME" || match.status === "FULL_TIME") {
    if (lastEventAt) {
      const age = now.getTime() - Date.parse(lastEventAt);
      if (Number.isFinite(age) && age > 120_000) {
        return "STALE";
      }
    }
    return "LIVE";
  }
  return "LIVE";
}

export class LiveScoringPipeline {
  private readonly unresolved: UnresolvedProviderEvent[] = [];

  constructor(
    private readonly store: LivePipelineStore,
    private readonly idMap: ProviderIdMap,
    private readonly cache: LiveScoreCache,
    private readonly hub: LiveScoreHub,
    private readonly metrics: LiveMetrics,
    private readonly audit: AuditStore,
    private readonly providerName: string,
  ) {}

  getUnresolved(): UnresolvedProviderEvent[] {
    return this.unresolved.map((row) => ({ ...row, rawPayload: { ...row.rawPayload } }));
  }

  async acceptNormalized(
    draft: NormalizedEventDraft,
    options: {
      matchId?: string;
      supersedesEventId?: string | null;
      ctx: RequestContext;
    },
  ): Promise<AcceptEventResult> {
    const existing = await this.store.findEventByProvider(draft.provider, draft.providerEventId);
    if (existing) {
      this.metrics.recordDuplicate();
      return { status: "duplicate", event: existing, reason: "provider+provider_event_id already stored" };
    }

    const matchId =
      options.matchId ??
      this.idMap.get(draft.provider, "fixture", draft.externalFixtureId) ??
      null;
    if (!matchId) {
      await this.recordUnresolved({
        provider: draft.provider,
        providerEventId: draft.providerEventId,
        matchId: null,
        externalFixtureId: draft.externalFixtureId,
        externalPlayerId: draft.primaryExternalPlayerId,
        externalTeamId: draft.externalTeamId,
        reason: "unresolved_fixture",
        rawPayload: draft.metadata,
        ctx: options.ctx,
      });
      return { status: "rejected", event: null, reason: "unresolved fixture mapping" };
    }

    const primaryPlayerId = draft.primaryExternalPlayerId
      ? this.idMap.get(draft.provider, "player", draft.primaryExternalPlayerId)
      : null;
    const secondaryPlayerId = draft.secondaryExternalPlayerId
      ? this.idMap.get(draft.provider, "player", draft.secondaryExternalPlayerId)
      : null;
    const teamId = draft.externalTeamId
      ? this.idMap.get(draft.provider, "club", draft.externalTeamId)
      : null;

    let unresolvedPlayer = false;
    if (draft.primaryExternalPlayerId && !primaryPlayerId) {
      unresolvedPlayer = true;
      this.metrics.recordUnresolvedPlayer();
      await this.recordUnresolved({
        provider: draft.provider,
        providerEventId: draft.providerEventId,
        matchId,
        externalFixtureId: draft.externalFixtureId,
        externalPlayerId: draft.primaryExternalPlayerId,
        externalTeamId: draft.externalTeamId,
        reason: "unresolved_primary_player",
        rawPayload: draft.metadata,
        ctx: options.ctx,
      });
    }
    if (draft.secondaryExternalPlayerId && !secondaryPlayerId) {
      unresolvedPlayer = true;
      this.metrics.recordUnresolvedPlayer();
      await this.recordUnresolved({
        provider: draft.provider,
        providerEventId: `${draft.providerEventId}:secondary`,
        matchId,
        externalFixtureId: draft.externalFixtureId,
        externalPlayerId: draft.secondaryExternalPlayerId,
        externalTeamId: draft.externalTeamId,
        reason: "unresolved_secondary_player",
        rawPayload: draft.metadata,
        ctx: options.ctx,
      });
    }

    await this.audit.append({
      action: "MATCH_EVENT_RECEIVED",
      occurredAt: options.ctx.now,
      entityType: "MATCH",
      entityId: matchId,
      metadata: {
        provider: draft.provider,
        providerEventId: draft.providerEventId,
        eventType: draft.eventType,
      },
      actorAccountId: null,
      actorWallet: null,
      correlationId: options.ctx.correlationId,
    });

    await this.audit.append({
      action: "MATCH_EVENT_NORMALIZED",
      occurredAt: options.ctx.now,
      entityType: "MATCH",
      entityId: matchId,
      metadata: {
        provider: draft.provider,
        providerEventId: draft.providerEventId,
        eventType: draft.eventType,
        rawEventHash: draft.rawEventHash,
        unresolvedPlayer,
      },
      actorAccountId: null,
      actorWallet: null,
      correlationId: options.ctx.correlationId,
    });

    const supersedesEventId = options.supersedesEventId ?? null;
    if (draft.correctionType || supersedesEventId) {
      this.metrics.recordCorrection();
      await this.audit.append({
        action: "MATCH_EVENT_CORRECTED",
        occurredAt: options.ctx.now,
        entityType: "MATCH",
        entityId: matchId,
        metadata: {
          providerEventId: draft.providerEventId,
          supersedesEventId,
          correctionType: draft.correctionType,
        },
        actorAccountId: null,
        actorWallet: null,
        correlationId: options.ctx.correlationId,
      });
    }

    const event: StoredMatchEvent = {
      eventId: newId(),
      matchId,
      provider: draft.provider,
      providerEventId: draft.providerEventId,
      sequence: draft.sequence,
      timestamp: draft.timestamp,
      matchMinute: draft.matchMinute,
      period: draft.period,
      eventType: draft.eventType,
      primaryPlayerId: primaryPlayerId,
      secondaryPlayerId: secondaryPlayerId,
      teamId,
      metadata: {
        ...draft.metadata,
        unresolvedPrimaryPlayer: Boolean(draft.primaryExternalPlayerId && !primaryPlayerId),
        unresolvedSecondaryPlayer: Boolean(draft.secondaryExternalPlayerId && !secondaryPlayerId),
        primaryExternalPlayerId: draft.primaryExternalPlayerId,
        secondaryExternalPlayerId: draft.secondaryExternalPlayerId,
        externalTeamId: draft.externalTeamId,
      },
      supersedesEventId,
      createdAt: options.ctx.now.toISOString(),
      correctionType: draft.correctionType,
      providerVersion: draft.providerVersion,
      rawEventHash: draft.rawEventHash,
    };

    const insertStatus = await this.store.insertEvent(event);
    if (insertStatus === "duplicate") {
      this.metrics.recordDuplicate();
      const again = await this.store.findEventByProvider(draft.provider, draft.providerEventId);
      return { status: "duplicate", event: again, reason: "duplicate on insert" };
    }
    this.metrics.recordAccepted();

    // Derived ASSIST from Sportmonks goal related player.
    if (draft.derivedAssist) {
      const assistDraft: NormalizedEventDraft = {
        ...draft,
        providerEventId: draft.derivedAssist.providerEventId,
        eventType: "ASSIST",
        primaryExternalPlayerId: draft.derivedAssist.primaryExternalPlayerId,
        secondaryExternalPlayerId: null,
        correctionType: null,
        sequence: draft.sequence,
        metadata: { ...draft.metadata, derivedFrom: draft.providerEventId, derived: "ASSIST" },
        derivedAssist: undefined,
        requiresPrimaryPlayer: true,
      };
      await this.acceptNormalized(assistDraft, { matchId, ctx: options.ctx });
    }

    // Auto GOAL_CONCEDED companion for opposing club (weight 0 in DEV_V1).
    if (event.eventType === "GOAL" && !event.supersedesEventId) {
      await this.maybeAppendGoalConceded(event, options.ctx);
    }

    const score = await this.recomputeMatch(matchId, options.ctx, event);
    return {
      status: unresolvedPlayer ? "unresolved_player" : "accepted",
      event,
      score,
      reason: unresolvedPlayer ? "event stored with unresolved player mapping" : undefined,
    };
  }

  private async maybeAppendGoalConceded(goal: StoredMatchEvent, ctx: RequestContext): Promise<void> {
    const match = await this.store.getMatch(goal.matchId);
    if (!match || !goal.teamId) {
      return;
    }
    const concedingClubId =
      goal.teamId === match.homeClubId
        ? match.awayClubId
        : goal.teamId === match.awayClubId
          ? match.homeClubId
          : null;
    if (!concedingClubId) {
      return;
    }
    const providerEventId = `${goal.providerEventId}:conceded`;
    const existing = await this.store.findEventByProvider(goal.provider, providerEventId);
    if (existing) {
      return;
    }
    const conceded: StoredMatchEvent = {
      eventId: newId(),
      matchId: goal.matchId,
      provider: goal.provider,
      providerEventId,
      sequence: goal.sequence,
      timestamp: goal.timestamp,
      matchMinute: goal.matchMinute,
      period: goal.period,
      eventType: "GOAL_CONCEDED",
      primaryPlayerId: null,
      secondaryPlayerId: null,
      teamId: concedingClubId,
      metadata: {
        derivedFrom: goal.eventId,
        derived: "GOAL_CONCEDED",
        scoringClubId: goal.teamId,
      },
      supersedesEventId: null,
      createdAt: ctx.now.toISOString(),
      correctionType: null,
      providerVersion: goal.providerVersion,
      rawEventHash: goal.rawEventHash,
    };
    await this.store.insertEvent(conceded);
  }

  async recomputeMatch(
    matchId: string,
    ctx: RequestContext,
    triggerEvent?: StoredMatchEvent,
  ): Promise<RecomputeResult> {
    const match = await this.store.getMatch(matchId);
    if (!match) {
      throw new Error("match not found");
    }
    const events = await this.store.listEvents(matchId);
    const scoringEvents = events.map(toScoringInput);
    const players = await this.store.listPlayers();
    const squad = await this.store.listSquad(matchId);
    const playerById = new Map(players.map((player) => [player.id, player]));

    const seeds: LineupSeed[] = squad.map((row) => {
      const player = playerById.get(row.playerId);
      return {
        playerId: row.playerId,
        clubId: row.clubId,
        position: player?.position ?? row.fantasyPosition,
        startingStatus: row.startingStatus,
        availability: row.availability,
        squadStatus: row.squadStatus,
      };
    });
    const pitch = derivePitchStates(seeds, events);

    const goalConcededDiagnostics: RecomputeResult["goalConcededDiagnostics"] = [];
    for (const event of effectiveEvents(scoringEvents)) {
      if (event.eventType !== "GOAL_CONCEDED") {
        continue;
      }
      const stored = events.find((row) => row.eventId === event.eventId);
      const eligibility = eligibleForGoalConceded(pitch, stored?.teamId ?? null);
      goalConcededDiagnostics.push({
        eventId: event.eventId,
        eligiblePlayerIds: eligibility.eligiblePlayerIds,
        unresolved: eligibility.unresolved,
        reason: eligibility.reason,
      });
    }

    const affectedPlayerIds = new Set<string>();
    for (const event of effectiveEvents(scoringEvents)) {
      if (event.primaryPlayerId) {
        affectedPlayerIds.add(event.primaryPlayerId);
      }
    }
    for (const player of players) {
      // Ensure squad players appear even at zero after rebuild.
      if (squad.some((row) => row.playerId === player.id)) {
        affectedPlayerIds.add(player.id);
      }
    }

    const matchContext = {
      matchId: match.id,
      homeClubId: match.homeClubId,
      awayClubId: match.awayClubId,
    };

    const playerScores = [...affectedPlayerIds].sort().map((playerId) => ({
      playerId,
      baseMilliPoints: calculatePlayerPoints(scoringEvents, playerId, DEV_V1_RULESET, matchContext, "player"),
    }));

    const teams = await this.store.listTeamsByMatch(matchId);
    const teamScores: TeamLiveScoreCache[] = [];
    const updates: LiveScoreUpdate[] = [];

    for (const team of teams) {
      const versions = await this.store.listVersions(team.id);
      const latest = versions.at(-1);
      if (!latest) {
        continue;
      }
      const scored = calculateTeamPoints(
        scoringEvents,
        {
          playerIds: latest.playerIds,
          captainId: latest.captainId,
          viceId: latest.viceId,
        },
        DEV_V1_RULESET,
        matchContext,
      );
      const cacheRow: TeamLiveScoreCache = {
        teamId: team.id,
        matchId,
        milliPoints: scored.milliPoints,
        scale: scored.scale,
        players: scored.players.map((player) => ({
          playerId: player.playerId,
          baseMilliPoints: player.baseMilliPoints,
          milliPoints: player.milliPoints,
          role:
            player.playerId === latest.captainId
              ? "captain"
              : player.playerId === latest.viceId
                ? "vice"
                : "player",
        })),
        updatedAt: ctx.now.toISOString(),
      };
      teamScores.push(cacheRow);
      await this.cache.writeTeam(cacheRow);

      if (triggerEvent?.primaryPlayerId && latest.playerIds.includes(triggerEvent.primaryPlayerId)) {
        const row = cacheRow.players.find((player) => player.playerId === triggerEvent.primaryPlayerId);
        const role = row?.role ?? "player";
        const multiplier =
          role === "captain"
            ? DEV_V1_RULESET.captainMultiplier
            : role === "vice"
              ? DEV_V1_RULESET.viceMultiplier
              : null;
        const baseForEvent =
          DEV_V1_RULESET.eventWeights[triggerEvent.eventType as ScoringEventType] ?? 0;
        const contribution = row
          ? row.milliPoints - (row.baseMilliPoints - baseForEvent === row.baseMilliPoints ? 0 : 0)
          : 0;
        void contribution;
        const update: LiveScoreUpdate = {
          type: "score_update",
          matchId,
          eventId: triggerEvent.eventId,
          eventType: triggerEvent.eventType,
          playerId: triggerEvent.primaryPlayerId,
          timestamp: triggerEvent.timestamp,
          baseMilliPoints: baseForEvent,
          multiplier,
          contributionMilliPoints: row?.milliPoints ?? 0,
          teamId: team.id,
          teamTotalMilliPoints: cacheRow.milliPoints,
          explanation: {
            event: triggerEvent.eventType,
            playerId: triggerEvent.primaryPlayerId,
            basePoints: baseForEvent / DEV_V1_SCALE,
            multiplierLabel:
              role === "captain" ? "captain 2/1" : role === "vice" ? "vice 3/2" : null,
            contribution: (row?.milliPoints ?? 0) / DEV_V1_SCALE,
            newTeamTotal: cacheRow.milliPoints / DEV_V1_SCALE,
          },
        };
        updates.push(update);
        this.hub.publish(matchId, update);
      }
    }

    const leaderboard = teamScores
      .map((row) => {
        const team = teams.find((item) => item.id === row.teamId);
        return {
          teamId: row.teamId,
          accountId: team?.accountId ?? "",
          milliPoints: row.milliPoints,
        };
      })
      .sort((a, b) => b.milliPoints - a.milliPoints || a.teamId.localeCompare(b.teamId))
      .map((row, index) => ({ ...row, rank: index + 1 }));

    const lastEventAt = events.reduce<string | null>((latest, event) => {
      if (!latest || event.timestamp > latest) {
        return event.timestamp;
      }
      return latest;
    }, null);
    const freshness = freshnessFor(match, lastEventAt, ctx.now);

    const matchCache: MatchLiveScoreCache = {
      matchId,
      freshness,
      eventCount: events.length,
      lastEventAt,
      providerName: this.providerName,
      playerScores: playerScores.map((player) => ({
        ...player,
        matchId,
        updatedAt: ctx.now.toISOString(),
      })),
      updatedAt: ctx.now.toISOString(),
    };
    await this.cache.writeMatch(matchCache);
    await this.cache.writeLeaderboard({
      matchId,
      contestId: null,
      rows: leaderboard,
      updatedAt: ctx.now.toISOString(),
      freshness,
    });

    this.metrics.recordRecompute();
    await this.audit.append({
      action: "SCORE_RECOMPUTED",
      occurredAt: ctx.now,
      entityType: "MATCH",
      entityId: matchId,
      metadata: {
        eventCount: events.length,
        teamCount: teamScores.length,
        ruleset: DEV_V1_RULESET.name,
        triggerEventId: triggerEvent?.eventId ?? null,
      },
      actorAccountId: null,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });

    this.hub.publish(matchId, {
      type: "health",
      matchId,
      connected: true,
      delayed: freshness === "STALE",
      lastEventAgeMs: lastEventAt ? ctx.now.getTime() - Date.parse(lastEventAt) : null,
      providerName: this.providerName,
      eventCount: events.length,
      freshness,
    });

    return {
      matchId,
      freshness,
      playerScores,
      teamScores,
      leaderboard,
      eventCount: events.length,
      lastEventAt,
      goalConcededDiagnostics,
      updates,
    };
  }

  async rebuildFromEvents(matchId: string, ctx: RequestContext): Promise<RecomputeResult> {
    const teams = await this.store.listTeamsByMatch(matchId);
    const events = await this.store.listEvents(matchId);
    const playerIds = [
      ...new Set(events.flatMap((event) => [event.primaryPlayerId, event.secondaryPlayerId].filter(Boolean) as string[])),
    ];
    await this.cache.clearMatch(
      matchId,
      playerIds,
      teams.map((team) => team.id),
    );
    this.metrics.recordRedisRebuild();
    return this.recomputeMatch(matchId, ctx);
  }

  private async recordUnresolved(input: {
    provider: string;
    providerEventId: string;
    matchId: string | null;
    externalFixtureId: string | null;
    externalPlayerId: string | null;
    externalTeamId: string | null;
    reason: string;
    rawPayload: Record<string, unknown>;
    ctx: RequestContext;
  }): Promise<void> {
    const row: UnresolvedProviderEvent = {
      id: newId(),
      provider: input.provider,
      providerEventId: input.providerEventId,
      matchId: input.matchId,
      externalFixtureId: input.externalFixtureId,
      externalPlayerId: input.externalPlayerId,
      externalTeamId: input.externalTeamId,
      reason: input.reason,
      rawPayload: input.rawPayload,
      createdAt: input.ctx.now.toISOString(),
    };
    this.unresolved.push(row);
    if (this.store.recordUnresolved) {
      await this.store.recordUnresolved(row);
    }
    await this.audit.append({
      action: "MATCH_EVENT_REJECTED",
      occurredAt: input.ctx.now,
      entityType: "MATCH",
      entityId: input.matchId ?? input.externalFixtureId ?? "unknown",
      metadata: {
        reason: input.reason,
        providerEventId: input.providerEventId,
        externalPlayerId: input.externalPlayerId,
      },
      actorAccountId: null,
      actorWallet: null,
      correlationId: input.ctx.correlationId,
    });
  }
}

export type { MatchRecord, PlayerRecord, SquadRecord, FantasyTeamVersionRecord };
