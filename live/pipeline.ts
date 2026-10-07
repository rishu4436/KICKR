import type { AuditStore } from "../audit/types.js";
import { DEV_V1_RULESET, type ScoringRuleset } from "../domain/scoring/dev-v1.js";
import {
  calculatePlayerPoints,
  calculateTeamPoints,
  effectiveEvents,
  type ScoringEventInput,
} from "../domain/scoring/engine.js";
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
import { explainEventContribution } from "./contribution.js";
import { computeFreshness } from "./freshness.js";
import {
  computeScoreSnapshotId,
  eventLogFingerprint,
} from "./score-snapshot.js";
import { compareTiedEntries } from "../settlement/tie-policy.js";

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
  upsertSquadRow(row: SquadRecord): Promise<void>;
  recordUnresolved?(row: UnresolvedProviderEvent): Promise<void>;
  listUnresolved?(matchId?: string): Promise<UnresolvedProviderEvent[]>;
}

/**
 * Contest scoring resolves contest_entries.team_version_id exactly.
 * Never substitutes the fantasy team's latest version for an entry.
 */
export interface ContestScoringEntry {
  entryId: string;
  contestId: string;
  wallet: string;
  teamVersionId: string;
  status: string;
}

export interface ContestScoringSource {
  listEntriesForMatch(matchId: string): Promise<ContestScoringEntry[]>;
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
  leaderboard: Array<{
    entryId: string;
    contestId: string;
    teamVersionId: string;
    wallet: string;
    milliPoints: number;
    rank: number;
    priorRank: number | null;
    scoreDelta: number | null;
  }>;
  personalTeamScores: TeamLiveScoreCache[];
  contestEntryScores: Array<TeamLiveScoreCache & { entryId: string; contestId: string; teamVersionId: string }>;
  eventCount: number;
  lastEventAt: string | null;
  lastSuccessfulPollAt: string | null;
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
    private readonly contestSource: ContestScoringSource | null = null,
    private readonly ruleset: ScoringRuleset = DEV_V1_RULESET,
  ) {}

  getRuleset(): ScoringRuleset {
    return this.ruleset;
  }

  getUnresolved(): UnresolvedProviderEvent[] {
    return this.unresolved.map((row) => ({ ...row, rawPayload: { ...row.rawPayload } }));
  }

  /** Entry ids that participate in contest live scoring (PENDING/CONFIRMED). */
  async listScoringEntryIds(matchId: string): Promise<string[]> {
    if (!this.contestSource) {
      return [];
    }
    const entries = await this.contestSource.listEntriesForMatch(matchId);
    return entries
      .filter((entry) => entry.status === "PENDING" || entry.status === "CONFIRMED")
      .map((entry) => entry.entryId)
      .sort();
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
    const eventsBefore = triggerEvent
      ? scoringEvents.filter((event) => event.eventId !== triggerEvent.eventId)
      : scoringEvents;
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
      baseMilliPoints: calculatePlayerPoints(scoringEvents, playerId, this.ruleset, matchContext, "player"),
    }));

    // Personal current-team scores (latest version) — not used for contest leaderboards.
    const personalTeams = await this.store.listTeamsByMatch(matchId);
    const personalTeamScores: TeamLiveScoreCache[] = [];
    for (const team of personalTeams) {
      const versions = await this.store.listVersions(team.id);
      const latest = versions.at(-1);
      if (!latest) {
        continue;
      }
      const scored = calculateTeamPoints(
        scoringEvents,
        { playerIds: latest.playerIds, captainId: latest.captainId, viceId: latest.viceId },
        this.ruleset,
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
      personalTeamScores.push(cacheRow);
      await this.cache.writeTeam(cacheRow);
    }

    // Contest entry scores: entry.team_version_id exactly. Never latest fantasy version.
    const contestEntries = this.contestSource
      ? await this.contestSource.listEntriesForMatch(matchId)
      : [];
    const contestEntryScores: RecomputeResult["contestEntryScores"] = [];
    const updates: LiveScoreUpdate[] = [];

    for (const entry of contestEntries) {
      if (entry.status !== "PENDING" && entry.status !== "CONFIRMED") {
        continue;
      }
      const owned = await this.store.getVersionById(entry.teamVersionId);
      if (!owned) {
        continue;
      }
      const version = owned.version;
      // Defend against silent drift: score the frozen version id on the entry.
      if (version.id !== entry.teamVersionId) {
        throw new Error("contest entry team_version_id resolution mismatch");
      }
      const scored = calculateTeamPoints(
        scoringEvents,
        { playerIds: version.playerIds, captainId: version.captainId, viceId: version.viceId },
        this.ruleset,
        matchContext,
      );
      const cacheRow: TeamLiveScoreCache & {
        entryId: string;
        contestId: string;
        teamVersionId: string;
      } = {
        teamId: version.teamId,
        matchId,
        milliPoints: scored.milliPoints,
        scale: scored.scale,
        players: scored.players.map((player) => ({
          playerId: player.playerId,
          baseMilliPoints: player.baseMilliPoints,
          milliPoints: player.milliPoints,
          role:
            player.playerId === version.captainId
              ? "captain"
              : player.playerId === version.viceId
                ? "vice"
                : "player",
        })),
        updatedAt: ctx.now.toISOString(),
        entryId: entry.entryId,
        contestId: entry.contestId,
        teamVersionId: entry.teamVersionId,
      };
      contestEntryScores.push(cacheRow);

      if (triggerEvent?.primaryPlayerId && version.playerIds.includes(triggerEvent.primaryPlayerId)) {
        const explanation = explainEventContribution({
          eventsBefore,
          eventsAfter: scoringEvents,
          trigger: toScoringInput(triggerEvent),
          playerIds: version.playerIds,
          captainId: version.captainId,
          viceId: version.viceId,
          matchContext,
        });
        const update: LiveScoreUpdate = {
          type: "score_update",
          matchId,
          eventId: triggerEvent.eventId,
          eventType: triggerEvent.eventType,
          playerId: triggerEvent.primaryPlayerId,
          timestamp: triggerEvent.timestamp,
          baseMilliPoints: explanation.baseMilliPoints,
          multiplier: explanation.multiplier,
          contributionMilliPoints: explanation.contributionMilliPoints,
          entryId: entry.entryId,
          contestId: entry.contestId,
          teamVersionId: entry.teamVersionId,
          teamId: version.teamId,
          previousPlayerTotalMilliPoints: explanation.previousPlayerTotalMilliPoints,
          newPlayerTotalMilliPoints: explanation.newPlayerTotalMilliPoints,
          previousTeamTotalMilliPoints: explanation.previousTeamTotalMilliPoints,
          newTeamTotalMilliPoints: explanation.newTeamTotalMilliPoints,
          explanation: {
            event: explanation.event,
            playerId: explanation.playerId,
            basePoints: explanation.basePoints,
            multiplierLabel: explanation.multiplierLabel,
            contribution: explanation.contribution,
            previousPlayerTotal: explanation.previousPlayerTotal,
            newPlayerTotal: explanation.newPlayerTotal,
            previousTeamTotal: explanation.previousTeamTotal,
            newTeamTotal: explanation.newTeamTotal,
          },
        };
        updates.push(update);
        this.hub.publish(matchId, update);
      }
    }

    const priorBoard = await this.cache.readLeaderboard(matchId);
    const priorByEntry = new Map(
      (priorBoard?.rows ?? []).map((row) => {
        const entryId = row.entryId ?? row.teamId ?? "";
        return [
          entryId,
          {
            rank: row.rank,
            milliPoints: row.milliPoints,
          },
        ] as const;
      }),
    );

    const leaderboard = contestEntryScores
      .map((row) => {
        const entry = contestEntries.find((item) => item.entryId === row.entryId);
        return {
          entryId: row.entryId,
          contestId: row.contestId,
          teamVersionId: row.teamVersionId,
          wallet: entry?.wallet ?? "",
          milliPoints: row.milliPoints,
        };
      })
      .sort((a, b) =>
        compareTiedEntries(
          { finalScoreMilliPoints: a.milliPoints, entryId: a.entryId },
          { finalScoreMilliPoints: b.milliPoints, entryId: b.entryId },
        ),
      )
      .map((row, index) => {
        const prior = priorByEntry.get(row.entryId);
        return {
          ...row,
          rank: index + 1,
          priorRank: prior?.rank ?? null,
          scoreDelta: prior ? row.milliPoints - prior.milliPoints : null,
        };
      });

    const fingerprint = eventLogFingerprint(events);
    const lastEventAt = fingerprint.lastEventAt;
    const scoreSnapshotId = computeScoreSnapshotId({
      eventCount: fingerprint.eventCount,
      lastEventAt: fingerprint.lastEventAt,
      lastEventId: fingerprint.lastEventId,
      entryIds: contestEntryScores.map((row) => row.entryId),
    });
    const metricsSnap = this.metrics.snapshot();
    const freshness = computeFreshness({
      matchStatus: match.status,
      now: ctx.now,
      lastSuccessfulPollAt: metricsSnap.lastSuccessfulPollAt,
      ingestionLagMs: metricsSnap.ingestionLagMs,
    });

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
      scoreSnapshotId,
    };
    await this.cache.writeMatch(matchCache);
    await this.cache.writeLeaderboard({
      matchId,
      contestId: leaderboard[0]?.contestId ?? null,
      rows: leaderboard.map((row) => ({
        entryId: row.entryId,
        contestId: row.contestId,
        teamVersionId: row.teamVersionId,
        wallet: row.wallet,
        milliPoints: row.milliPoints,
        rank: row.rank,
        priorRank: row.priorRank,
        scoreDelta: row.scoreDelta,
        // Compat aliases for older readers
        teamId: row.entryId,
        accountId: row.wallet,
      })),
      updatedAt: ctx.now.toISOString(),
      freshness,
      scoreSnapshotId,
      eventCount: fingerprint.eventCount,
      lastEventAt,
    });

    this.metrics.recordRecompute();
    await this.audit.append({
      action: "SCORE_RECOMPUTED",
      occurredAt: ctx.now,
      entityType: "MATCH",
      entityId: matchId,
      metadata: {
        eventCount: events.length,
        personalTeamCount: personalTeamScores.length,
        contestEntryCount: contestEntryScores.length,
        ruleset: this.ruleset.name,
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
      lastSuccessfulPollAgeMs: metricsSnap.lastSuccessfulPollAt
        ? ctx.now.getTime() - Date.parse(metricsSnap.lastSuccessfulPollAt)
        : null,
      lastEventOccurrenceAt: lastEventAt,
      providerName: this.providerName,
      eventCount: events.length,
      freshness,
    });

    return {
      matchId,
      freshness,
      playerScores,
      teamScores: personalTeamScores,
      personalTeamScores,
      contestEntryScores,
      leaderboard,
      eventCount: events.length,
      lastEventAt,
      lastSuccessfulPollAt: metricsSnap.lastSuccessfulPollAt,
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
    // Keep prior leaderboard briefly so recompute can emit rank movement / score delta.
    const priorBoard = await this.cache.readLeaderboard(matchId);
    await this.cache.clearMatch(
      matchId,
      playerIds,
      teams.map((team) => team.id),
    );
    if (priorBoard) {
      await this.cache.writeLeaderboard(priorBoard);
    }
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
