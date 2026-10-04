import type { AuditStore } from "../audit/types.js";
import type { RequestContext } from "../auth/types.js";
import type { FootballService } from "../football/service.js";
import { AppError } from "../shared/errors.js";
import type { ContestDiscoveryCache } from "./discovery.js";
import type { ContestStore } from "./store.js";
import type { ContestLimits, ContestRecord, DiscoveryView, EntryRecord, ReservationRecord } from "./types.js";
import { assertBaseUnits } from "./types.js";
import { buildDepositPlan, type DepositPlan, type EscrowClientConfig } from "../solana/escrow.js";
import { assertDevCluster, DEFAULT_ESCROW_PROGRAM_ID } from "../solana/ids.js";

export interface QuoteView {
  contestId: string;
  wallet: string;
  teamVersionId: string;
  entryAmountBaseUnits: number;
  currency: "USDC";
  escrow: ReservationRecord["escrowPlaceholder"];
  nonce: string;
  issuedAt: string;
  expiresAt: string;
}

export interface ReservationView {
  reservation: ReservationRecord;
  entry: EntryRecord;
  quote: QuoteView;
  contest: DiscoveryView;
  payment: "PAYMENT COMING IN PHASE 4";
  /** Null until USDC_MINT is configured. A plan is not a payment and not a confirmation. */
  depositPlan: DepositPlan | null;
}

const JOINABLE = new Set(["OPEN", "PARTIALLY_FILLED"]);

function discoveryOf(contest: ContestRecord): DiscoveryView {
  const estimatedPrizePoolBaseUnits = assertBaseUnits(
    contest.filledCount * contest.entryFeeBaseUnits,
    "estimated prize pool",
  );
  return {
    matchId: contest.matchId,
    contestId: contest.id,
    templateId: contest.templateId,
    templateCode: contest.rulesSnapshot.templateCode,
    contestType: contest.contestType,
    entryFeeBaseUnits: contest.entryFeeBaseUnits,
    currency: "USDC",
    capacity: contest.capacity,
    filledCount: contest.filledCount,
    remaining: contest.capacity - contest.filledCount,
    status: contest.status,
    lockTime: contest.rulesSnapshot.lockTime,
    estimatedPrizePoolBaseUnits,
    estimated: true,
    funded: false,
    estimateLabel: "filled entries times entry fee; not funded money",
  };
}

function quoteOf(reservation: ReservationRecord): QuoteView {
  return {
    contestId: reservation.contestId,
    wallet: reservation.wallet,
    teamVersionId: reservation.teamVersionId,
    entryAmountBaseUnits: reservation.amountBaseUnits,
    currency: "USDC",
    escrow: reservation.escrowPlaceholder,
    nonce: reservation.nonce,
    issuedAt: reservation.issuedAt,
    expiresAt: reservation.expiresAt,
  };
}

/**
 * Contest engine. Join creates a PENDING reservation and a PENDING entry.
 * It does not transfer USDC, set CONFIRMED, settle, or emit ENTRY_CONFIRMED.
 */
export class ContestService {
  constructor(
    private readonly store: ContestStore,
    private readonly football: FootballService,
    private readonly audit: AuditStore,
    private readonly cache: ContestDiscoveryCache,
    private readonly limits: ContestLimits & { reservationTtlSeconds: number },
    private readonly escrow: EscrowClientConfig = {
      programId: DEFAULT_ESCROW_PROGRAM_ID,
      usdcMint: "",
      usdcDecimals: 6,
      cluster: "devnet",
    },
  ) {
    assertDevCluster(this.escrow.cluster);
  }

  async listDiscoverable(matchId: string, ctx: RequestContext): Promise<DiscoveryView[]> {
    const match = await this.football.getMatch(matchId);
    if (!match) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    const created = await this.ensureEnabled(matchId, match.kickoffAt, ctx);
    if (created) {
      await this.cache.invalidateMatch(matchId);
    }
    const cached = await this.cache.readMatch(matchId);
    if (cached) {
      return cached;
    }
    const rows = (await this.store.listDiscoverable(matchId)).map(discoveryOf);
    await this.cache.writeMatch(matchId, rows);
    return rows;
  }

  /**
   * Joinable discovery for every signed-in wallet, plus contests on this match
   * where this wallet has a confirmed entry (FULL, LOCKED, or settled).
   * Entered rows are read from the store, not the shared discovery cache, so
   * another wallet does not see them and a stale open snapshot cannot hide them.
   */
  async listMatchContests(matchId: string, wallet: string, ctx: RequestContext): Promise<DiscoveryView[]> {
    const open = await this.listDiscoverable(matchId, ctx);
    const entered = (await this.store.listWithConfirmedEntry(matchId, wallet)).map(discoveryOf);
    const enteredById = new Map(entered.map((row) => [row.contestId, row]));
    const merged = open
      .filter((row) => !enteredById.has(row.contestId))
      .concat(entered);
    return merged;
  }

  async listAllContests(): Promise<ContestRecord[]> {
    return this.store.listContests();
  }

  async findEntry(entryId: string): Promise<EntryRecord | null> {
    return this.store.getEntry(entryId);
  }

  async getContest(id: string): Promise<DiscoveryView> {
    const contest = await this.store.getContest(id);
    if (!contest) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return discoveryOf(contest);
  }

  async reserve(
    contestId: string,
    accountId: string,
    wallet: string,
    teamVersionId: string,
    ctx: RequestContext,
  ): Promise<ReservationView> {
    const owned = await this.football.getVersionForAccount(teamVersionId, accountId);
    if (!owned) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    if (owned.team.status === "LOCKED") {
      throw new AppError("TEAM_LOCKED", 409, "Locked team cannot be modified");
    }
    if (!owned.version.validationResult.valid) {
      throw new AppError("FANTASY_TEAM_INVALID", 400, "Fantasy team is invalid");
    }
    const contest = await this.store.getContest(contestId);
    if (!contest) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    if (owned.version.matchId !== contest.matchId || owned.team.matchId !== contest.matchId) {
      throw new AppError("TEAM_MATCH_MISMATCH", 409, "Team does not belong to this match");
    }
    if (!JOINABLE.has(contest.status)) {
      if (contest.status === "FULL") {
        throw new AppError("CONTEST_FULL", 409, "Contest is full", { details: { refresh: true } });
      }
      throw new AppError("CONTEST_NOT_JOINABLE", 409, "Contest is not open for reservations");
    }

    const result = await this.store.reserveSeat({
      contestId,
      wallet,
      teamVersionId,
      now: ctx.now,
      ttlSeconds: this.limits.reservationTtlSeconds,
      limits: this.limits,
    });
    if (result.entry.status !== "PENDING" || result.reservation.status !== "PENDING") {
      throw new AppError("INTERNAL", 500, "Internal error", { expose: false });
    }

    await this.audit.append({
      action: "JOIN_QUOTED",
      occurredAt: ctx.now,
      entityType: "RESERVATION",
      entityId: result.reservation.id,
      metadata: {
        contestId,
        teamVersionId,
        amountBaseUnits: result.reservation.amountBaseUnits,
        currency: "USDC",
        payment: "not_attempted",
      },
      actorAccountId: accountId,
      actorWallet: wallet,
      correlationId: ctx.correlationId,
    });
    await this.audit.append({
      action: "ENTRY_RESERVED",
      occurredAt: ctx.now,
      entityType: "ENTRY",
      entityId: result.entry.id,
      metadata: {
        contestId,
        reservationId: result.reservation.id,
        seatNumber: result.entry.seatNumber,
        status: "PENDING",
        teamVersionId,
      },
      actorAccountId: accountId,
      actorWallet: wallet,
      correlationId: ctx.correlationId,
    });
    if (result.filled) {
      await this.audit.append({
        action: "CONTEST_FILLED",
        occurredAt: ctx.now,
        entityType: "CONTEST",
        entityId: result.contest.id,
        metadata: {
          filledCount: result.contest.filledCount,
          capacity: result.contest.capacity,
          nextContestId: result.nextContest?.id ?? null,
        },
        actorAccountId: accountId,
        actorWallet: wallet,
        correlationId: ctx.correlationId,
      });
    }
    if (result.nextContest) {
      await this.audit.append({
        action: "CONTEST_CREATED",
        occurredAt: ctx.now,
        entityType: "CONTEST",
        entityId: result.nextContest.id,
        metadata: {
          matchId: result.nextContest.matchId,
          templateId: result.nextContest.templateId,
          templateVersion: result.nextContest.rulesSnapshot.templateVersion,
          status: result.nextContest.status,
          filledCount: 0,
        },
        actorAccountId: null,
        actorWallet: null,
        correlationId: ctx.correlationId,
      });
    }
    await this.cache.invalidateMatch(contest.matchId);
    const entry = await this.store.getEntry(result.entry.id);
    if (!entry || entry.teamVersionId !== teamVersionId || entry.status !== "PENDING") {
      throw new AppError("INTERNAL", 500, "Internal error", { expose: false });
    }
    return {
      reservation: result.reservation,
      entry,
      quote: quoteOf(result.reservation),
      contest: discoveryOf(result.contest),
      payment: "PAYMENT COMING IN PHASE 4",
      depositPlan: this.planFor(result.reservation),
    };
  }

  /**
   * Records that the user submitted a signature. This does not confirm the
   * entry, does not move USDC, and does not emit ENTRY_CONFIRMED.
   */
  async submitDepositSignature(
    reservationId: string,
    wallet: string,
    signature: string,
    ctx: RequestContext,
  ): Promise<ReservationView> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,100}$/.test(signature)) {
      throw new AppError("VALIDATION", 400, "Signature is not a Solana transaction signature");
    }
    const current = await this.store.getReservation(reservationId, ctx.now);
    if (!current || current.wallet !== wallet) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    const reservation = await this.store.submitDeposit(reservationId, signature, ctx.now);
    await this.audit.append({
      action: "DEPOSIT_SUBMITTED",
      occurredAt: ctx.now,
      entityType: "ENTRY",
      entityId: reservationId,
      metadata: {
        signature,
        contestId: reservation.contestId,
        confirmed: false,
        commitment: "submitted",
      },
      actorAccountId: null,
      actorWallet: wallet,
      correlationId: ctx.correlationId,
    });
    return this.viewReservation(reservation, ctx);
  }

  async listDeposits(contestId: string): Promise<EntryRecord[]> {
    const contest = await this.store.getContest(contestId);
    if (!contest) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return this.store.listEntries(contestId);
  }

  async depositHealth() {
    return this.store.depositHealth();
  }

  async getReservation(id: string, wallet: string, ctx: RequestContext): Promise<ReservationView> {
    const reservation = await this.store.getReservation(id, ctx.now);
    if (!reservation || reservation.wallet !== wallet) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    const entries = await this.store.listEntries(reservation.contestId);
    const entry = entries.find((row) => row.reservationId === reservation.id);
    const contest = await this.store.getContest(reservation.contestId);
    if (!entry || !contest) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return {
      reservation,
      entry,
      quote: quoteOf(reservation),
      contest: discoveryOf(contest),
      payment: "PAYMENT COMING IN PHASE 4",
      depositPlan: this.planFor(reservation),
    };
  }

  /**
   * Support and the join route cannot confirm a reservation. The indexer is
   * the only caller of confirmVerifiedDeposit, and only after finalized
   * verification. This method still refuses.
   */
  async rejectConfirmation(id: string, ctx: RequestContext): Promise<never> {
    const reservation = await this.store.getReservation(id, ctx.now);
    if (!reservation) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    if (reservation.status === "EXPIRED" || Date.parse(reservation.expiresAt) <= ctx.now.getTime()) {
      throw new AppError("RESERVATION_EXPIRED", 409, "Expired reservation cannot become valid");
    }
    throw new AppError("PHASE4_REQUIRED", 409, "Phase 3 cannot confirm a reservation or mark an entry paid");
  }

  async ensureOpenContest(matchId: string, templateId: string, ctx: RequestContext): Promise<ContestRecord> {
    const match = await this.football.getMatch(matchId);
    if (!match) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    const result = await this.store.ensureJoinable(matchId, templateId, match.kickoffAt, ctx.now);
    if (result.created) {
      await this.auditCreated(result.contest, ctx);
      await this.cache.invalidateMatch(matchId);
    }
    return result.contest;
  }

  async updateTemplateFee(templateId: string, entryFeeBaseUnits: number, ctx: RequestContext) {
    return this.store.updateTemplate(templateId, { entryFeeBaseUnits }, ctx.now);
  }

  /**
   * Locks joinable contests for a match and freezes teams that already have a seat.
   * Does not pay, refund, or settle. Server-side; not a frontend flag.
   */
  async lockContestsForMatch(matchId: string, ctx: RequestContext): Promise<ContestRecord[]> {
    const locked = await this.store.lockJoinableForMatch(matchId, ctx.now);
    for (const contest of locked) {
      await this.audit.append({
        action: "CONTEST_LOCKED",
        occurredAt: ctx.now,
        entityType: "CONTEST",
        entityId: contest.id,
        metadata: { matchId, status: contest.status, financial: false },
        actorAccountId: null,
        actorWallet: null,
        correlationId: ctx.correlationId,
      });
      const entries = await this.store.listEntries(contest.id);
      for (const entry of entries) {
        const version = await this.football.getVersionById(entry.teamVersionId);
        if (version && version.team.status === "DRAFT") {
          await this.football.lockTeam(version.team.id, version.team.accountId, ctx);
        }
      }
    }
    await this.cache.invalidateMatch(matchId);
    return locked;
  }

  /**
   * In-process lock pass. A later distributed worker can call the same method.
   * This is not a production scheduler and it does not start a process.
   * TODO: whether kickoff alone, or only an explicit match LOCKED status, is the
   * production rule is implemented as either. Match status itself is not changed here.
   */
  async lockDue(now: Date, ctx: RequestContext): Promise<string[]> {
    const matches = await this.football.listMatches();
    const ids: string[] = [];
    for (const match of matches) {
      const kickoffPassed = Date.parse(match.kickoffAt) <= now.getTime();
      if (match.status !== "LOCKED" && !kickoffPassed) {
        continue;
      }
      const locked = await this.lockContestsForMatch(match.id, { ...ctx, now });
      ids.push(...locked.map((contest) => contest.id));
    }
    return ids;
  }

  private planFor(reservation: ReservationRecord): DepositPlan | null {
    if (!this.escrow.usdcMint) {
      return null;
    }
    return buildDepositPlan({
      config: this.escrow,
      contestId: reservation.contestId,
      wallet: reservation.wallet,
      teamVersionId: reservation.teamVersionId,
      reservationNonce: reservation.nonce,
      feeBaseUnits: reservation.amountBaseUnits,
      expiresAt: reservation.expiresAt,
    });
  }

  private async viewReservation(reservation: ReservationRecord, _ctx: RequestContext): Promise<ReservationView> {
    const entries = await this.store.listEntries(reservation.contestId);
    const entry = entries.find((row) => row.reservationId === reservation.id);
    const contest = await this.store.getContest(reservation.contestId);
    if (!entry || !contest) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return {
      reservation,
      entry,
      quote: quoteOf(reservation),
      contest: discoveryOf(contest),
      payment: "PAYMENT COMING IN PHASE 4",
      depositPlan: this.planFor(reservation),
    };
  }

  private async ensureEnabled(matchId: string, lockTime: string, ctx: RequestContext): Promise<boolean> {
    const templates = await this.store.listEnabledTemplates();
    let created = false;
    for (const template of templates) {
      const result = await this.store.ensureJoinable(matchId, template.id, lockTime, ctx.now);
      if (result.created) {
        created = true;
        await this.auditCreated(result.contest, ctx);
      }
    }
    return created;
  }

  private async auditCreated(contest: ContestRecord, ctx: RequestContext): Promise<void> {
    await this.audit.append({
      action: "CONTEST_CREATED",
      occurredAt: ctx.now,
      entityType: "CONTEST",
      entityId: contest.id,
      metadata: {
        matchId: contest.matchId,
        templateId: contest.templateId,
        templateVersion: contest.rulesSnapshot.templateVersion,
        entryFeeBaseUnits: contest.entryFeeBaseUnits,
        capacity: contest.capacity,
        contestType: contest.contestType,
      },
      actorAccountId: null,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });
  }
}
