/**
 * Phase 18D.2 Match Operations — private operator-assisted fixture + live scoring.
 * Human confirmation required before any score mutation. Uses existing LIVE_V1 pipeline.
 */
import type { AuditStore } from "../audit/types.js";
import type { RequestContext } from "../auth/types.js";
import type { PlayerRole } from "../domain/football/roles.js";
import { isPlayerRole } from "../domain/football/roles.js";
import type { MatchState } from "../domain/state-machine.js";
import { transition } from "../domain/state-machine.js";
import type {
  ClubRecord,
  FootballStore,
  MatchRecord,
  PlayerRecord,
  SquadRecord,
  StoredMatchEvent,
} from "../football/store.js";
import type { LiveScoringService } from "../live/service.js";
import { newId } from "../shared/ids.js";
import { AppError } from "../shared/errors.js";
import {
  EVENT_PROVENANCE,
  OPERATOR_CREDIT_MAX,
  OPERATOR_CREDIT_MIN,
  OPERATOR_EVENT_TYPES,
  OPERATOR_PROVENANCE,
  OPERATOR_PROVIDER_NAME,
  isOperatorEventType,
  isOperatorManagedDataSource,
  isSportmonksDataSource,
  isTutorialDemoDataSource,
  operatorMatchLabel,
  type OperatorEventType,
} from "../sports/operator-provider.js";

export type ProposalStatus = "PROPOSED" | "REVIEWED" | "CONFIRMED" | "REJECTED";
export type ProposalSource = "MANUAL_OPERATOR" | "GROK_PROPOSED";

export interface MatchOpsActor {
  accountId: string;
  walletAddress: string;
  role: string;
  requestId: string | null;
}

export interface CreditAuditRow {
  id: string;
  matchId: string;
  playerId: string;
  squadRowId: string;
  previousCredit: number;
  newCredit: number;
  actorAccountId: string;
  actorRole: string;
  reason: string;
  requestId: string | null;
  createdAt: string;
}

export interface EventProposal {
  id: string;
  matchId: string;
  status: ProposalStatus;
  eventType: OperatorEventType;
  primaryPlayerId: string;
  secondaryPlayerId: string | null;
  matchMinute: number | null;
  note: string | null;
  source: ProposalSource;
  provenance: "MANUAL_OPERATOR" | "GROK_PROPOSED_MANUAL_CONFIRMED";
  proposedByAccountId: string | null;
  reviewedByAccountId: string | null;
  confirmedByAccountId: string | null;
  confirmedEventId: string | null;
  providerEventId: string;
  requestId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MutationAuditRow {
  id: string;
  actorAccountId: string;
  actorRole: string;
  action: string;
  fixtureId: string | null;
  entityType: string;
  entityId: string;
  beforeState: Record<string, unknown>;
  afterState: Record<string, unknown>;
  reason: string | null;
  requestId: string | null;
  createdAt: string;
}

export interface MatchOpsDeps {
  footballStore: FootballStore;
  live: LiveScoringService | null | undefined;
  audit: AuditStore;
  clock: () => Date;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemoryMatchOpsStore {
  creditAudits: CreditAuditRow[] = [];
  proposals: EventProposal[] = [];
  mutations: MutationAuditRow[] = [];
}

export interface CreateFixtureInput {
  competition: string;
  venue?: string | null;
  kickoffAt: string;
  homeClub: { name: string; shortName: string };
  awayClub: { name: string; shortName: string };
  players: Array<{
    displayName: string;
    shortName: string;
    position: PlayerRole;
    clubSide: "home" | "away";
    creditValue: number;
    jersey?: number | null;
    startingStatus?: "STARTER" | "BENCH" | "UNKNOWN";
    availability?: "AVAILABLE" | "UNAVAILABLE" | "UNKNOWN";
  }>;
}

export function createMatchOperationsService(deps: MatchOpsDeps, memory = new InMemoryMatchOpsStore()) {
  async function appendMutation(
    actor: MatchOpsActor,
    action: MutationAuditRow["action"],
    fixtureId: string | null,
    entityType: string,
    entityId: string,
    beforeState: Record<string, unknown>,
    afterState: Record<string, unknown>,
    reason: string | null,
  ): Promise<MutationAuditRow> {
    const row: MutationAuditRow = {
      id: newId(),
      actorAccountId: actor.accountId,
      actorRole: actor.role,
      action,
      fixtureId,
      entityType,
      entityId,
      beforeState,
      afterState,
      reason,
      requestId: actor.requestId,
      createdAt: deps.clock().toISOString(),
    };
    memory.mutations.push(clone(row));
    return row;
  }

  async function requireOperatorMatch(matchId: string): Promise<MatchRecord> {
    const match = await deps.footballStore.getMatch(matchId);
    if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
    if (isSportmonksDataSource(match.dataSource.provider)) {
      throw new AppError(
        "MATCH_OPS_REFUSED",
        403,
        "Sportmonks fixtures are authoritative; Match Ops simulator/manual scoring is forbidden",
      );
    }
    if (isTutorialDemoDataSource(match.dataSource.provider)) {
      throw new AppError(
        "MATCH_OPS_REFUSED",
        403,
        "Tutorial Match is SIMULATED; use tutorial controls, not Match Ops writes",
      );
    }
    if (!isOperatorManagedDataSource(match.dataSource)) {
      throw new AppError(
        "MATCH_OPS_REFUSED",
        403,
        "Match Ops writes are limited to OPERATOR_MANAGED fixtures",
      );
    }
    return match;
  }

  function validateCredit(value: number): void {
    if (!Number.isInteger(value) || value < OPERATOR_CREDIT_MIN || value > OPERATOR_CREDIT_MAX) {
      throw new AppError(
        "VALIDATION",
        400,
        `creditValue must be an integer between ${OPERATOR_CREDIT_MIN} and ${OPERATOR_CREDIT_MAX}`,
      );
    }
  }

  async function createFixture(actor: MatchOpsActor, input: CreateFixtureInput) {
    const competition = input.competition.trim();
    if (competition.length < 2 || competition.length > 120) {
      throw new AppError("VALIDATION", 400, "competition length invalid");
    }
    const kickoff = Date.parse(input.kickoffAt);
    if (!Number.isFinite(kickoff)) {
      throw new AppError("VALIDATION", 400, "kickoffAt must be an ISO timestamp");
    }
    if (!input.players.length) {
      throw new AppError("VALIDATION", 400, "players pool required");
    }
    for (const player of input.players) {
      if (!isPlayerRole(player.position)) {
        throw new AppError("VALIDATION", 400, `invalid position ${player.position}`);
      }
      validateCredit(player.creditValue);
    }

    const nowIso = deps.clock().toISOString();
    const homeClub: ClubRecord = {
      id: newId(),
      name: input.homeClub.name.trim(),
      shortName: input.homeClub.shortName.trim().slice(0, 8),
      providerId: `operator-club-${newId().slice(0, 8)}`,
    };
    const awayClub: ClubRecord = {
      id: newId(),
      name: input.awayClub.name.trim(),
      shortName: input.awayClub.shortName.trim().slice(0, 8),
      providerId: `operator-club-${newId().slice(0, 8)}`,
    };
    if (!homeClub.name || !awayClub.name || homeClub.name === awayClub.name) {
      throw new AppError("VALIDATION", 400, "home and away clubs must be distinct named clubs");
    }

    const matchId = newId();
    const match: MatchRecord = {
      id: matchId,
      homeClubId: homeClub.id,
      awayClubId: awayClub.id,
      kickoffAt: new Date(kickoff).toISOString(),
      competition,
      venue: input.venue?.trim() || null,
      externalFixtureId: `operator-${matchId}`,
      status: "SCHEDULED",
      lineupAvailable: false,
      dataSource: {
        provider: OPERATOR_PROVIDER_NAME,
        provenance: OPERATOR_PROVENANCE,
        label: operatorMatchLabel(),
        fetchedAt: nowIso,
      },
    };

    if (!deps.footballStore.upsertClub || !deps.footballStore.upsertPlayer || !deps.footballStore.upsertMatch) {
      throw new AppError("NOT_FOUND", 500, "Football store does not support Match Ops mutations");
    }
    await deps.footballStore.upsertClub(homeClub);
    await deps.footballStore.upsertClub(awayClub);
    // Persist match before squad rows (match_squad.match_id FK).
    await deps.footballStore.upsertMatch(match);

    const players: PlayerRecord[] = [];
    const squad: SquadRecord[] = [];
    for (const [index, row] of input.players.entries()) {
      const clubId = row.clubSide === "home" ? homeClub.id : awayClub.id;
      const player: PlayerRecord = {
        id: newId(),
        displayName: row.displayName.trim(),
        shortName: row.shortName.trim().slice(0, 16),
        position: row.position,
        clubId,
        active: true,
        providerId: `operator-player-${newId().slice(0, 8)}`,
      };
      players.push(player);
      await deps.footballStore.upsertPlayer(player);
      const squadRow: SquadRecord = {
        id: newId(),
        matchId,
        playerId: player.id,
        clubId,
        fantasyPosition: row.position,
        creditValue: row.creditValue,
        availability: row.availability ?? "AVAILABLE",
        startingStatus: row.startingStatus ?? (index < 11 ? "STARTER" : "BENCH"),
        squadStatus: "INCLUDED",
        providerId: `operator-squad-${player.providerId}`,
        sourceVersion: "operator-1",
        sourcedAt: nowIso,
      };
      if (row.jersey != null) {
        // Jersey is operator UI metadata only; not a squad column.
        void row.jersey;
      }
      squad.push(squadRow);
      await deps.footballStore.upsertSquadRow(squadRow);
    }

    const hasLineup = squad.some((s) => s.startingStatus === "STARTER");
    if (hasLineup && deps.footballStore.updateMatchFields) {
      await deps.footballStore.updateMatchFields(matchId, {
        status: "LINEUPS_AVAILABLE",
        lineupAvailable: true,
      });
      match.status = "LINEUPS_AVAILABLE";
      match.lineupAvailable = true;
    }

    await appendMutation(
      actor,
      "MATCH_OPS_FIXTURE_CREATED",
      matchId,
      "MATCH",
      matchId,
      {},
      { match, homeClub, awayClub, playerCount: players.length },
      "create upcoming operator-managed fixture",
    );
    await deps.audit.append({
      action: "MATCH_OPS_FIXTURE_CREATED",
      occurredAt: deps.clock(),
      entityType: "MATCH",
      entityId: matchId,
      metadata: {
        provenance: OPERATOR_PROVENANCE,
        provider: OPERATOR_PROVIDER_NAME,
        competition,
        playerCount: players.length,
        actorRole: actor.role,
        notSportmonks: true,
        requestId: actor.requestId,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId,
    });

    return { match, homeClub, awayClub, players, squad };
  }

  async function updateFixture(
    actor: MatchOpsActor,
    matchId: string,
    patch: {
      competition?: string;
      venue?: string | null;
      kickoffAt?: string;
      status?: MatchState;
      reason?: string;
    },
  ) {
    const before = await requireOperatorMatch(matchId);
    if (!deps.footballStore.updateMatchFields) {
      throw new AppError("NOT_FOUND", 500, "Football store missing updateMatchFields");
    }
    const fields: Parameters<NonNullable<FootballStore["updateMatchFields"]>>[1] = {};
    if (patch.competition !== undefined) {
      const c = patch.competition.trim();
      if (c.length < 2) throw new AppError("VALIDATION", 400, "competition too short");
      fields.competition = c;
    }
    if (patch.venue !== undefined) fields.venue = patch.venue;
    if (patch.kickoffAt !== undefined) {
      const t = Date.parse(patch.kickoffAt);
      if (!Number.isFinite(t)) throw new AppError("VALIDATION", 400, "kickoffAt invalid");
      fields.kickoffAt = new Date(t).toISOString();
    }
    if (patch.status !== undefined) {
      // Validate transition without mutating until store update
      transition("MATCH", before.status, patch.status);
      fields.status = patch.status;
      if (patch.status === "LINEUPS_AVAILABLE") fields.lineupAvailable = true;
    }
    const after = await deps.footballStore.updateMatchFields(matchId, fields);
    await appendMutation(
      actor,
      "MATCH_OPS_FIXTURE_UPDATED",
      matchId,
      "MATCH",
      matchId,
      { match: before },
      { match: after },
      patch.reason ?? "operator fixture update",
    );
    await deps.audit.append({
      action: "MATCH_OPS_FIXTURE_UPDATED",
      occurredAt: deps.clock(),
      entityType: "MATCH",
      entityId: matchId,
      metadata: {
        before: { status: before.status, competition: before.competition, kickoffAt: before.kickoffAt },
        after: { status: after.status, competition: after.competition, kickoffAt: after.kickoffAt },
        actorRole: actor.role,
        provenance: OPERATOR_PROVENANCE,
        notSportmonks: true,
        requestId: actor.requestId,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId,
    });
    return after;
  }

  async function updateSquadPlayer(
    actor: MatchOpsActor,
    matchId: string,
    playerId: string,
    patch: {
      fantasyPosition?: PlayerRole;
      creditValue?: number;
      startingStatus?: SquadRecord["startingStatus"];
      availability?: SquadRecord["availability"];
      squadStatus?: SquadRecord["squadStatus"];
      reason?: string;
    },
  ) {
    await requireOperatorMatch(matchId);
    const squad = await deps.footballStore.listSquad(matchId);
    const row = squad.find((s) => s.playerId === playerId);
    if (!row) throw new AppError("NOT_FOUND", 404, "Squad player not found");
    const before = clone(row);
    if (patch.fantasyPosition !== undefined) {
      if (!isPlayerRole(patch.fantasyPosition)) {
        throw new AppError("VALIDATION", 400, "invalid fantasyPosition");
      }
      row.fantasyPosition = patch.fantasyPosition;
    }
    if (patch.creditValue !== undefined) {
      validateCredit(patch.creditValue);
      row.creditValue = patch.creditValue;
    }
    if (patch.startingStatus !== undefined) row.startingStatus = patch.startingStatus;
    if (patch.availability !== undefined) row.availability = patch.availability;
    if (patch.squadStatus !== undefined) row.squadStatus = patch.squadStatus;
    row.sourcedAt = deps.clock().toISOString();
    row.sourceVersion = `operator-${Date.now()}`;
    await deps.footballStore.upsertSquadRow(row);
    await appendMutation(
      actor,
      "MATCH_OPS_SQUAD_UPDATED",
      matchId,
      "SQUAD",
      row.id,
      { squad: before },
      { squad: row },
      patch.reason ?? "squad update",
    );
    await deps.audit.append({
      action: "MATCH_OPS_SQUAD_UPDATED",
      occurredAt: deps.clock(),
      entityType: "SQUAD",
      entityId: row.id,
      metadata: {
        matchId,
        playerId,
        before,
        after: row,
        actorRole: actor.role,
        requestId: actor.requestId,
        notSportmonks: true,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId,
    });
    return row;
  }

  async function editCredit(
    actor: MatchOpsActor,
    matchId: string,
    playerId: string,
    newCredit: number,
    reason: string,
  ) {
    await requireOperatorMatch(matchId);
    validateCredit(newCredit);
    const trimmed = reason.trim();
    if (trimmed.length < 3 || trimmed.length > 500) {
      throw new AppError("VALIDATION", 400, "reason must be 3–500 characters");
    }
    const squad = await deps.footballStore.listSquad(matchId);
    const row = squad.find((s) => s.playerId === playerId);
    if (!row) throw new AppError("NOT_FOUND", 404, "Squad player not found");
    const previous = row.creditValue;
    if (previous === newCredit) {
      throw new AppError("VALIDATION", 400, "new credit equals previous credit");
    }
    row.creditValue = newCredit;
    row.sourcedAt = deps.clock().toISOString();
    await deps.footballStore.upsertSquadRow(row);
    const auditRow: CreditAuditRow = {
      id: newId(),
      matchId,
      playerId,
      squadRowId: row.id,
      previousCredit: previous,
      newCredit,
      actorAccountId: actor.accountId,
      actorRole: actor.role,
      reason: trimmed,
      requestId: actor.requestId,
      createdAt: deps.clock().toISOString(),
    };
    memory.creditAudits.push(clone(auditRow));
    await appendMutation(
      actor,
      "MATCH_OPS_CREDIT_EDITED",
      matchId,
      "SQUAD_CREDIT",
      row.id,
      { creditValue: previous },
      { creditValue: newCredit },
      trimmed,
    );
    await deps.audit.append({
      action: "MATCH_OPS_CREDIT_EDITED",
      occurredAt: deps.clock(),
      entityType: "SQUAD",
      entityId: row.id,
      metadata: {
        matchId,
        playerId,
        previousCredit: previous,
        newCredit,
        reason: trimmed,
        actorRole: actor.role,
        appliesToFutureSelectionsOnly: true,
        frozenTeamVersionsUnaffected: true,
        requestId: actor.requestId,
        notSportmonks: true,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId,
    });
    return { squad: row, audit: auditRow };
  }

  async function proposeEvent(
    actor: MatchOpsActor,
    input: {
      matchId: string;
      eventType: string;
      primaryPlayerId: string;
      secondaryPlayerId?: string | null;
      matchMinute?: number | null;
      note?: string | null;
      source: ProposalSource;
      providerEventId?: string;
    },
  ): Promise<EventProposal> {
    await requireOperatorMatch(input.matchId);
    if (!isOperatorEventType(input.eventType)) {
      throw new AppError(
        "VALIDATION",
        400,
        `eventType must be one of ${OPERATOR_EVENT_TYPES.join(", ")}`,
      );
    }
    if (input.matchMinute != null && (!Number.isInteger(input.matchMinute) || input.matchMinute < 0 || input.matchMinute > 130)) {
      throw new AppError("VALIDATION", 400, "matchMinute out of range");
    }
    const squad = await deps.footballStore.listSquad(input.matchId);
    if (!squad.some((s) => s.playerId === input.primaryPlayerId)) {
      throw new AppError("VALIDATION", 400, "primaryPlayerId not in match squad");
    }
    if (input.secondaryPlayerId && !squad.some((s) => s.playerId === input.secondaryPlayerId)) {
      throw new AppError("VALIDATION", 400, "secondaryPlayerId not in match squad");
    }
    const providerEventId =
      input.providerEventId?.trim() ||
      `operator:${input.matchId}:${input.eventType}:${input.primaryPlayerId}:${input.matchMinute ?? "na"}:${newId().slice(0, 8)}`;
    if (memory.proposals.some((p) => p.providerEventId === providerEventId)) {
      throw new AppError("VALIDATION", 409, "duplicate providerEventId");
    }
    const existingEvent = await deps.footballStore.findEventByProvider(OPERATOR_PROVIDER_NAME, providerEventId);
    if (existingEvent) {
      throw new AppError("VALIDATION", 409, "providerEventId already scored");
    }
    const nowIso = deps.clock().toISOString();
    const proposal: EventProposal = {
      id: newId(),
      matchId: input.matchId,
      status: "PROPOSED",
      eventType: input.eventType,
      primaryPlayerId: input.primaryPlayerId,
      secondaryPlayerId: input.secondaryPlayerId ?? null,
      matchMinute: input.matchMinute ?? null,
      note: input.note?.trim() || null,
      source: input.source,
      provenance:
        input.source === "GROK_PROPOSED"
          ? "GROK_PROPOSED_MANUAL_CONFIRMED"
          : "MANUAL_OPERATOR",
      proposedByAccountId: actor.accountId,
      reviewedByAccountId: null,
      confirmedByAccountId: null,
      confirmedEventId: null,
      providerEventId,
      requestId: actor.requestId,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    // Grok proposals keep provisional provenance label until confirm; scoring blocked until CONFIRMED.
    if (input.source === "GROK_PROPOSED") {
      proposal.provenance = "GROK_PROPOSED_MANUAL_CONFIRMED";
    }
    memory.proposals.push(clone(proposal));
    await appendMutation(
      actor,
      "MATCH_OPS_EVENT_PROPOSED",
      input.matchId,
      "EVENT_PROPOSAL",
      proposal.id,
      {},
      { proposal },
      input.note ?? null,
    );
    await deps.audit.append({
      action: "MATCH_OPS_EVENT_PROPOSED",
      occurredAt: deps.clock(),
      entityType: "EVENT_PROPOSAL",
      entityId: proposal.id,
      metadata: {
        matchId: input.matchId,
        eventType: proposal.eventType,
        source: proposal.source,
        status: proposal.status,
        scoresUntilConfirmed: false,
        requestId: actor.requestId,
        notSportmonks: true,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId,
    });
    return clone(proposal);
  }

  async function reviewProposal(actor: MatchOpsActor, proposalId: string): Promise<EventProposal> {
    const proposal = memory.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new AppError("NOT_FOUND", 404, "Proposal not found");
    await requireOperatorMatch(proposal.matchId);
    if (proposal.status !== "PROPOSED") {
      throw new AppError("VALIDATION", 409, `Cannot review proposal in status ${proposal.status}`);
    }
    const before = clone(proposal);
    proposal.status = "REVIEWED";
    proposal.reviewedByAccountId = actor.accountId;
    proposal.updatedAt = deps.clock().toISOString();
    await appendMutation(
      actor,
      "MATCH_OPS_EVENT_REVIEWED",
      proposal.matchId,
      "EVENT_PROPOSAL",
      proposal.id,
      { proposal: before },
      { proposal },
      null,
    );
    await deps.audit.append({
      action: "MATCH_OPS_EVENT_REVIEWED",
      occurredAt: deps.clock(),
      entityType: "EVENT_PROPOSAL",
      entityId: proposal.id,
      metadata: {
        matchId: proposal.matchId,
        from: "PROPOSED",
        to: "REVIEWED",
        scoresUntilConfirmed: false,
        requestId: actor.requestId,
        notSportmonks: true,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId,
    });
    return clone(proposal);
  }

  async function confirmProposal(actor: MatchOpsActor, proposalId: string, ctx: RequestContext) {
    if (!deps.live) {
      throw new AppError("NOT_FOUND", 503, "Live scoring pipeline unavailable");
    }
    const proposal = memory.proposals.find((p) => p.id === proposalId);
    if (!proposal) throw new AppError("NOT_FOUND", 404, "Proposal not found");
    const match = await requireOperatorMatch(proposal.matchId);
    if (proposal.status !== "PROPOSED" && proposal.status !== "REVIEWED") {
      throw new AppError("VALIDATION", 409, `Cannot confirm proposal in status ${proposal.status}`);
    }
    if (proposal.source === "GROK_PROPOSED" && proposal.status === "PROPOSED") {
      // Allow confirm from PROPOSED for Grok after explicit human confirm (review optional but encouraged).
    }
    const squad = await deps.footballStore.listSquad(proposal.matchId);
    const primary = squad.find((s) => s.playerId === proposal.primaryPlayerId);
    if (!primary) throw new AppError("VALIDATION", 400, "primary player missing from squad");

    const events = await deps.footballStore.listEvents(proposal.matchId);
    const sequence = events.length + 1;
    const provenance =
      proposal.source === "GROK_PROPOSED"
        ? EVENT_PROVENANCE.GROK_PROPOSED_MANUAL_CONFIRMED
        : EVENT_PROVENANCE.MANUAL_OPERATOR;

    let supersedesEventId: string | null = null;
    let correctionType: StoredMatchEvent["correctionType"] = null;
    if (proposal.eventType === "VAR_REVERSAL") {
      const note = proposal.note ?? "";
      const ref = note.match(/supersedes:([0-9a-f-]{36})/i);
      if (!ref) {
        throw new AppError(
          "VALIDATION",
          400,
          "VAR_REVERSAL requires note containing supersedes:<eventId>",
        );
      }
      supersedesEventId = ref[1]!;
      const target = events.find((e) => e.eventId === supersedesEventId);
      if (!target) throw new AppError("VALIDATION", 400, "supersedes event not found");
      correctionType = "VAR_REVERSAL";
    }

    const event: StoredMatchEvent = {
      eventId: newId(),
      matchId: proposal.matchId,
      provider: OPERATOR_PROVIDER_NAME,
      providerEventId: proposal.providerEventId,
      sequence,
      timestamp: ctx.now.toISOString(),
      matchMinute: proposal.matchMinute,
      period: null,
      eventType: proposal.eventType,
      primaryPlayerId: proposal.primaryPlayerId,
      secondaryPlayerId: proposal.secondaryPlayerId,
      teamId: primary.clubId,
      metadata: {
        provenance,
        source: proposal.source,
        note: proposal.note,
        confirmedBy: actor.accountId,
        notSportmonks: true,
        operatorManaged: true,
        proposalId: proposal.id,
      },
      supersedesEventId,
      createdAt: ctx.now.toISOString(),
      correctionType,
      providerVersion: "operator-1",
      rawEventHash: null,
    };

    const insertStatus = await deps.footballStore.insertEvent(event);
    if (insertStatus === "duplicate") {
      throw new AppError("VALIDATION", 409, "duplicate event rejected (idempotent)");
    }

    const before = clone(proposal);
    proposal.status = "CONFIRMED";
    proposal.confirmedByAccountId = actor.accountId;
    proposal.confirmedEventId = event.eventId;
    proposal.provenance =
      proposal.source === "GROK_PROPOSED"
        ? "GROK_PROPOSED_MANUAL_CONFIRMED"
        : "MANUAL_OPERATOR";
    proposal.updatedAt = ctx.now.toISOString();

    const rebuilt = await deps.live.pipeline.rebuildFromEvents(proposal.matchId, ctx);

    await appendMutation(
      actor,
      "MATCH_OPS_EVENT_CONFIRMED",
      proposal.matchId,
      "EVENT_PROPOSAL",
      proposal.id,
      { proposal: before },
      { proposal, eventId: event.eventId },
      proposal.note,
    );
    await deps.audit.append({
      action: "MATCH_OPS_EVENT_CONFIRMED",
      occurredAt: ctx.now,
      entityType: "MATCH_EVENT",
      entityId: event.eventId,
      metadata: {
        matchId: proposal.matchId,
        proposalId: proposal.id,
        eventType: event.eventType,
        provenance,
        provider: OPERATOR_PROVIDER_NAME,
        matchLabel: match.dataSource.label,
        leaderboardRows: rebuilt.leaderboard.length,
        requestId: actor.requestId,
        notSportmonks: true,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId ?? ctx.correlationId,
    });

    return { proposal: clone(proposal), event, rebuilt };
  }

  async function appendCorrection(
    actor: MatchOpsActor,
    input: {
      matchId: string;
      originalEventId: string;
      note?: string | null;
      providerEventId?: string;
    },
    ctx: RequestContext,
  ) {
    if (!deps.live) {
      throw new AppError("NOT_FOUND", 503, "Live scoring pipeline unavailable");
    }
    await requireOperatorMatch(input.matchId);
    const events = await deps.footballStore.listEvents(input.matchId);
    const original = events.find((e) => e.eventId === input.originalEventId);
    if (!original) throw new AppError("NOT_FOUND", 404, "Original event not found");
    if (original.provider !== OPERATOR_PROVIDER_NAME) {
      throw new AppError("MATCH_OPS_REFUSED", 403, "Can only correct OPERATOR_MANAGED events via Match Ops");
    }
    const providerEventId =
      input.providerEventId?.trim() ||
      `operator:correction:${input.originalEventId}:${newId().slice(0, 8)}`;
    const dup = await deps.footballStore.findEventByProvider(OPERATOR_PROVIDER_NAME, providerEventId);
    if (dup) throw new AppError("VALIDATION", 409, "duplicate correction rejected");

    const correction: StoredMatchEvent = {
      eventId: newId(),
      matchId: input.matchId,
      provider: OPERATOR_PROVIDER_NAME,
      providerEventId,
      sequence: events.length + 1,
      timestamp: ctx.now.toISOString(),
      matchMinute: original.matchMinute,
      period: original.period,
      eventType: "VAR_REVERSAL",
      primaryPlayerId: original.primaryPlayerId,
      secondaryPlayerId: original.secondaryPlayerId,
      teamId: original.teamId,
      metadata: {
        provenance: EVENT_PROVENANCE.MANUAL_OPERATOR,
        correctionOf: original.eventId,
        note: input.note ?? null,
        notSportmonks: true,
        operatorManaged: true,
      },
      supersedesEventId: original.eventId,
      createdAt: ctx.now.toISOString(),
      correctionType: "VAR_REVERSAL",
      providerVersion: "operator-1",
      rawEventHash: null,
    };
    const status = await deps.footballStore.insertEvent(correction);
    if (status === "duplicate") {
      throw new AppError("VALIDATION", 409, "duplicate correction rejected");
    }
    const rebuilt = await deps.live.pipeline.rebuildFromEvents(input.matchId, ctx);
    await appendMutation(
      actor,
      "MATCH_OPS_CORRECTION_APPENDED",
      input.matchId,
      "MATCH_EVENT",
      correction.eventId,
      { originalEventId: original.eventId },
      { correctionEventId: correction.eventId },
      input.note ?? "operator correction",
    );
    await deps.audit.append({
      action: "MATCH_OPS_CORRECTION_APPENDED",
      occurredAt: ctx.now,
      entityType: "MATCH_EVENT",
      entityId: correction.eventId,
      metadata: {
        matchId: input.matchId,
        originalEventId: original.eventId,
        deterministicReverse: true,
        requestId: actor.requestId,
        notSportmonks: true,
      },
      actorAccountId: actor.accountId,
      actorWallet: actor.walletAddress,
      correlationId: actor.requestId ?? ctx.correlationId,
    });
    return { correction, rebuilt };
  }

  async function listOperatorMatches() {
    const matches = await deps.footballStore.listMatches();
    return matches.filter((m) => isOperatorManagedDataSource(m.dataSource));
  }

  async function getMatchBundle(matchId: string) {
    const match = await deps.footballStore.getMatch(matchId);
    if (!match) throw new AppError("NOT_FOUND", 404, "Match not found");
    const [home, away, squad, players, events] = await Promise.all([
      deps.footballStore.getClub(match.homeClubId),
      deps.footballStore.getClub(match.awayClubId),
      deps.footballStore.listSquad(matchId),
      deps.footballStore.listPlayers(),
      deps.footballStore.listEvents(matchId),
    ]);
    const playerIds = new Set(squad.map((s) => s.playerId));
    return {
      match,
      home,
      away,
      squad,
      players: players.filter((p) => playerIds.has(p.id)),
      events,
      proposals: memory.proposals.filter((p) => p.matchId === matchId).map(clone),
      creditAudits: memory.creditAudits.filter((c) => c.matchId === matchId).map(clone),
      mutations: memory.mutations.filter((m) => m.fixtureId === matchId).map(clone),
      authority: isSportmonksDataSource(match.dataSource.provider)
        ? "SPORTMONKS"
        : isTutorialDemoDataSource(match.dataSource.provider)
          ? "SIMULATED"
          : isOperatorManagedDataSource(match.dataSource)
            ? "OPERATOR_MANAGED"
            : "UNKNOWN",
      manualScoringAllowed: isOperatorManagedDataSource(match.dataSource),
    };
  }

  function listMutations(fixtureId?: string) {
    const rows = fixtureId
      ? memory.mutations.filter((m) => m.fixtureId === fixtureId)
      : memory.mutations;
    return rows.map(clone);
  }

  function listProposals(matchId?: string) {
    const rows = matchId
      ? memory.proposals.filter((p) => p.matchId === matchId)
      : memory.proposals;
    return rows.map(clone);
  }

  function getMemory() {
    return memory;
  }

  return {
    createFixture,
    updateFixture,
    updateSquadPlayer,
    editCredit,
    proposeEvent,
    reviewProposal,
    confirmProposal,
    appendCorrection,
    listOperatorMatches,
    getMatchBundle,
    listMutations,
    listProposals,
    requireOperatorMatch,
    getMemory,
  };
}

export type MatchOperationsService = ReturnType<typeof createMatchOperationsService>;
