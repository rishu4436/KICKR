import { transition } from "../domain/state-machine.js";
import type { ContestState } from "../domain/state-machine.js";
import { newId, newNonce } from "../shared/ids.js";
import { AppError } from "../shared/errors.js";
import { DEV_FEE_POLICY, DEV_PAYOUT_POLICIES, DEV_SCORING_SNAPSHOT, DEV_TEMPLATES } from "./dev-catalog.js";
import type { ConfirmDepositInput, ConfirmDepositResult, ContestStore, DepositHealth, EnsureResult, ReserveResult, ReserveSeatInput } from "./store.js";
import type {
  ContestLimits,
  ContestRecord,
  ContestTemplateRecord,
  EntryRecord,
  FeePolicyRecord,
  OutboxRecord,
  PayoutPolicyRecord,
  ReservationRecord,
  RulesSnapshot,
} from "./types.js";
import { assertBaseUnits, ESCROW_PLACEHOLDER } from "./types.js";
import { nonceHash, toHex } from "../solana/escrow.js";

function clone<T>(value: T): T {
  return structuredClone(value);
}

const JOINABLE = new Set<ContestState>(["OPEN", "PARTIALLY_FILLED"]);

/**
 * Single-process store. `exclusive` is the transaction: overlapping callers
 * queue, and the seat update is a conditional increment. This is the same
 * invariant as SELECT FOR UPDATE plus `filled_count < capacity`, not a
 * check-then-act outside the critical section.
 *
 * CI has no Postgres. PGlite cannot run two connections in parallel either,
 * so the executed concurrency test uses this queue. The Postgres repository
 * uses a real BEGIN / FOR UPDATE transaction for the same conditional update.
 */
export class InMemoryContestStore implements ContestStore {
  private templates: ContestTemplateRecord[];
  private readonly payouts: PayoutPolicyRecord[];
  private readonly fees: FeePolicyRecord[];
  private contests: ContestRecord[] = [];
  private reservations: ReservationRecord[] = [];
  private entries: EntryRecord[] = [];
  private outbox: OutboxRecord[] = [];
  private rejections: Array<{ signature: string; reason: string; reservationId: string | null }> = [];
  /** Test hook. Production callers leave this at zero. */
  debugFailConfirmations = 0;
  private tail: Promise<void> = Promise.resolve();

  constructor() {
    this.templates = DEV_TEMPLATES.map((row) => clone(row));
    this.payouts = DEV_PAYOUT_POLICIES.map((row) => clone(row));
    this.fees = [clone(DEV_FEE_POLICY)];
  }

  private exclusive<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(() => fn());
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async listEnabledTemplates(): Promise<ContestTemplateRecord[]> {
    return this.exclusive(() => this.templates.filter((row) => row.enabled).map((row) => clone(row)));
  }

  async getTemplate(id: string): Promise<ContestTemplateRecord | null> {
    return this.exclusive(() => {
      const row = this.templates.find((template) => template.id === id);
      return row ? clone(row) : null;
    });
  }

  async updateTemplate(
    id: string,
    patch: { entryFeeBaseUnits?: number; enabled?: boolean },
    now: Date,
  ): Promise<ContestTemplateRecord> {
    return this.exclusive(() => {
      const row = this.templates.find((template) => template.id === id);
      if (!row) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
      if (patch.entryFeeBaseUnits !== undefined) {
        row.entryFeeBaseUnits = assertBaseUnits(patch.entryFeeBaseUnits, "entry fee");
      }
      if (patch.enabled !== undefined) {
        row.enabled = patch.enabled;
      }
      row.version += 1;
      row.updatedAt = now.toISOString();
      return clone(row);
    });
  }

  async replaceSnapshot(contestId: string, snapshot: RulesSnapshot): Promise<never> {
    void contestId;
    void snapshot;
    throw new Error("contest rules_snapshot is immutable");
  }

  async ensureJoinable(matchId: string, templateId: string, lockTime: string, now: Date): Promise<EnsureResult> {
    return this.exclusive(() => {
      const template = this.requireTemplate(templateId);
      const existing = this.findCurrent(matchId, template);
      if (existing) {
        return { contest: clone(existing), created: false };
      }
      const contest = this.insertContest(template, matchId, lockTime, now);
      return { contest: clone(contest), created: true };
    });
  }

  async reserveSeat(input: ReserveSeatInput): Promise<ReserveResult> {
    return this.exclusive(() => {
      const contest = this.contests.find((row) => row.id === input.contestId);
      if (!contest) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
      if (contest.status === "FULL" || contest.filledCount >= contest.capacity) {
        throw new AppError("CONTEST_FULL", 409, "Contest is full", { details: { refresh: true } });
      }
      if (!JOINABLE.has(contest.status)) {
        throw new AppError("CONTEST_NOT_JOINABLE", 409, "Contest is not open for reservations");
      }
      this.assertLimits(contest, input.wallet, input.limits);
      if (this.activeEntry(contest.id, input.wallet)) {
        throw new AppError("DUPLICATE_ENTRY", 409, "Wallet already has a seat in this contest");
      }
      if (this.pendingReservation(contest.id, input.teamVersionId)) {
        throw new AppError("DUPLICATE_RESERVATION", 409, "Team version already has a reservation in this contest");
      }
      if (contest.filledCount + 1 > contest.capacity) {
        throw new AppError("CONTEST_FULL", 409, "Contest is full", { details: { refresh: true } });
      }

      const nowIso = input.now.toISOString();
      const seatNumber = contest.filledCount + 1;
      contest.filledCount = seatNumber;
      if (contest.filledCount === contest.capacity) {
        contest.status = transition("CONTEST", contest.status, "FULL") as ContestState;
      } else if (contest.status === "OPEN") {
        contest.status = transition("CONTEST", contest.status, "PARTIALLY_FILLED") as ContestState;
      }
      contest.updatedAt = nowIso;

      const expires = new Date(input.now.getTime() + input.ttlSeconds * 1000);
      const nonce = newNonce();
      const reservation: ReservationRecord = {
        id: newId(),
        contestId: contest.id,
        wallet: input.wallet,
        teamVersionId: input.teamVersionId,
        amountBaseUnits: contest.entryFeeBaseUnits,
        currency: "USDC",
        nonce,
        escrowPlaceholder: { ...ESCROW_PLACEHOLDER },
        issuedAt: nowIso,
        expiresAt: expires.toISOString(),
        status: "PENDING",
        nonceHash: toHex(nonceHash(nonce)),
        depositSignature: null,
        submittedAt: null,
        confirmationStatus: "NONE",
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.reservations.push(reservation);
      const entry: EntryRecord = {
        id: newId(),
        contestId: contest.id,
        wallet: input.wallet,
        teamVersionId: input.teamVersionId,
        reservationId: reservation.id,
        status: "PENDING",
        seatNumber,
        joinedAt: nowIso,
        confirmationStatus: "PENDING",
        depositSignature: null,
        confirmedSlot: null,
        confirmedBlockTime: null,
        chainAmountBaseUnits: null,
        mint: null,
        vaultAddress: null,
        depositReceipt: null,
        createdAt: nowIso,
        updatedAt: nowIso,
      };
      this.entries.push(entry);

      let nextContest: ContestRecord | null = null;
      const filled = contest.status === "FULL";
      if (filled && contest.contestType === "HEAD_TO_HEAD") {
        this.outbox.push({
          id: newId(),
          eventType: "CONTEST_FILLED",
          contestId: contest.id,
          payload: { matchId: contest.matchId, templateId: contest.templateId, capacity: contest.capacity },
          createdAt: nowIso,
          publishedAt: null,
        });
        const template = this.requireTemplate(contest.templateId);
        nextContest = this.insertContest(template, contest.matchId, contest.rulesSnapshot.lockTime, input.now);
      }
      return {
        contest: clone(contest),
        reservation: clone(reservation),
        entry: clone(entry),
        nextContest: nextContest ? clone(nextContest) : null,
        filled,
      };
    });
  }

  async getContest(id: string): Promise<ContestRecord | null> {
    return this.exclusive(() => {
      const row = this.contests.find((contest) => contest.id === id);
      return row ? clone(row) : null;
    });
  }

  async listDiscoverable(matchId: string): Promise<ContestRecord[]> {
    return this.exclusive(() =>
      this.contests
        .filter((contest) => contest.matchId === matchId && JOINABLE.has(contest.status))
        .map((contest) => clone(contest)),
    );
  }

  async listByMatch(matchId: string): Promise<ContestRecord[]> {
    return this.exclusive(() =>
      this.contests.filter((contest) => contest.matchId === matchId).map((contest) => clone(contest)),
    );
  }

  async listEntries(contestId: string): Promise<EntryRecord[]> {
    return this.exclusive(() =>
      this.entries.filter((entry) => entry.contestId === contestId).map((entry) => clone(entry)),
    );
  }

  async getEntry(id: string): Promise<EntryRecord | null> {
    return this.exclusive(() => {
      const row = this.entries.find((entry) => entry.id === id);
      return row ? clone(row) : null;
    });
  }

  async getReservation(id: string, now: Date): Promise<ReservationRecord | null> {
    return this.exclusive(() => {
      const row = this.reservations.find((reservation) => reservation.id === id);
      if (!row) {
        return null;
      }
      if (row.status === "PENDING" && Date.parse(row.expiresAt) <= now.getTime()) {
        row.status = "EXPIRED";
        row.updatedAt = now.toISOString();
      }
      return clone(row);
    });
  }

  async lockJoinableForMatch(matchId: string, now: Date): Promise<ContestRecord[]> {
    return this.exclusive(() => {
      const locked: ContestRecord[] = [];
      const nowIso = now.toISOString();
      for (const contest of this.contests) {
        if (contest.matchId !== matchId) {
          continue;
        }
        if (contest.status !== "OPEN" && contest.status !== "PARTIALLY_FILLED" && contest.status !== "FULL") {
          continue;
        }
        contest.status = transition("CONTEST", contest.status, "LOCKED") as ContestState;
        contest.lockedAt = nowIso;
        contest.updatedAt = nowIso;
        locked.push(clone(contest));
      }
      return locked;
    });
  }

  async listUnpublishedOutbox(): Promise<OutboxRecord[]> {
    return this.exclusive(() => this.outbox.filter((row) => row.publishedAt === null).map((row) => clone(row)));
  }

  async markOutboxPublished(ids: readonly string[], now: Date): Promise<void> {
    await this.exclusive(() => {
      const wanted = new Set(ids);
      for (const row of this.outbox) {
        if (wanted.has(row.id) && row.publishedAt === null) {
          row.publishedAt = now.toISOString();
        }
      }
    });
  }


  async findReservationByNonceHash(hash: string): Promise<ReservationRecord | null> {
    return this.exclusive(() => {
      const row = this.reservations.find((reservation) => reservation.nonceHash === hash);
      return row ? clone(row) : null;
    });
  }

  async submitDeposit(reservationId: string, signature: string, now: Date): Promise<ReservationRecord> {
    return this.exclusive(() => {
      const row = this.reservations.find((reservation) => reservation.id === reservationId);
      if (!row) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
      if (row.status === "CONFIRMED" || row.confirmationStatus === "VERIFIED") {
        throw new AppError("ALREADY_CONFIRMED", 409, "Reservation is already confirmed");
      }
      if (row.status !== "PENDING") {
        throw new AppError("RESERVATION_EXPIRED", 409, "Expired reservation cannot become valid");
      }
      if (Date.parse(row.expiresAt) <= now.getTime()) {
        row.status = "EXPIRED";
        row.updatedAt = now.toISOString();
        throw new AppError("RESERVATION_EXPIRED", 409, "Expired reservation cannot become valid");
      }
      row.depositSignature = signature;
      row.submittedAt = now.toISOString();
      row.confirmationStatus = "SUBMITTED";
      row.updatedAt = row.submittedAt;
      return clone(row);
    });
  }

  async confirmVerifiedDeposit(input: ConfirmDepositInput): Promise<ConfirmDepositResult> {
    return this.exclusive(() => {
      if (this.debugFailConfirmations > 0) {
        this.debugFailConfirmations -= 1;
        throw new Error("db write failed");
      }
      const reservation = this.reservations.find((row) => row.id === input.reservationId);
      const entry = this.entries.find((row) => row.reservationId === input.reservationId);
      const contest = reservation ? this.contests.find((row) => row.id === reservation.contestId) : undefined;
      if (!reservation || !entry || !contest) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
      if (entry.teamVersionId !== input.teamVersionId) {
        throw new AppError("TEAM_VERSION_MISMATCH", 409, "Entry team version does not match the deposit");
      }
      if (entry.status === "CONFIRMED" && entry.depositSignature === input.signature) {
        return { contest: clone(contest), reservation: clone(reservation), entry: clone(entry), idempotent: true };
      }
      if (entry.status !== "PENDING" || reservation.status === "CONFIRMED") {
        throw new AppError("DUPLICATE", 409, "Deposit already recorded");
      }
      const nowIso = input.now.toISOString();
      entry.status = transition("ENTRY", entry.status, "CONFIRMED") as EntryRecord["status"];
      entry.confirmationStatus = "CONFIRMED";
      entry.depositSignature = input.signature;
      entry.confirmedSlot = input.slot;
      entry.confirmedBlockTime = input.blockTime === null ? null : new Date(input.blockTime * 1000).toISOString();
      entry.chainAmountBaseUnits = input.amountBaseUnits;
      entry.mint = input.mint;
      entry.vaultAddress = input.vault;
      entry.depositReceipt = input.depositReceipt;
      entry.updatedAt = nowIso;
      reservation.status = "CONFIRMED";
      reservation.confirmationStatus = "VERIFIED";
      reservation.depositSignature = input.signature;
      reservation.updatedAt = nowIso;
      contest.confirmedCount += 1;
      contest.escrowPda = input.contestPda;
      contest.vaultAddress = input.vault;
      contest.usdcMint = input.mint;
      contest.updatedAt = nowIso;
      if (
        contest.contestType === "HEAD_TO_HEAD" &&
        contest.confirmedCount === contest.capacity &&
        !this.outbox.some((row) => row.contestId === contest.id && row.eventType === "CONTEST_FILLED")
      ) {
        this.outbox.push({
          id: newId(),
          eventType: "CONTEST_FILLED",
          contestId: contest.id,
          payload: { matchId: contest.matchId, templateId: contest.templateId, confirmed: true },
          createdAt: nowIso,
          publishedAt: null,
        });
        const template = this.templates.find((row) => row.id === contest.templateId);
        if (template && !this.findCurrent(contest.matchId, template)) {
          this.insertContest(template, contest.matchId, contest.rulesSnapshot.lockTime, input.now);
        }
      }
      return { contest: clone(contest), reservation: clone(reservation), entry: clone(entry), idempotent: false };
    });
  }

  async recordRejection(input: { signature: string; reason: string; reservationId: string | null }): Promise<void> {
    await this.exclusive(() => {
      if (this.rejections.some((row) => row.signature === input.signature && row.reason === input.reason)) {
        return;
      }
      this.rejections.push(input);
      if (input.reservationId) {
        const reservation = this.reservations.find((row) => row.id === input.reservationId);
        if (reservation && reservation.confirmationStatus !== "VERIFIED") {
          reservation.confirmationStatus = "REJECTED";
          reservation.depositSignature = input.signature;
        }
      }
    });
  }

  async depositHealth(): Promise<DepositHealth> {
    return this.exclusive(() => ({
      pendingReservations: this.reservations.filter((row) => row.status === "PENDING").length,
      pendingEntries: this.entries.filter((row) => row.status === "PENDING").length,
      submittedDeposits: this.reservations.filter((row) => row.confirmationStatus === "SUBMITTED").length,
      rejectedDeposits: this.rejections.length,
      verifiedDeposits: this.entries.filter((row) => row.status === "CONFIRMED").length,
      reconciliationMismatches: this.rejections.length,
    }));
  }

  private requireTemplate(id: string): ContestTemplateRecord {
    const template = this.templates.find((row) => row.id === id);
    if (!template || !template.enabled) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return template;
  }

  private findCurrent(matchId: string, template: ContestTemplateRecord): ContestRecord | undefined {
    if (template.contestType === "HEAD_TO_HEAD") {
      return this.contests.find(
        (contest) =>
          contest.matchId === matchId &&
          contest.templateId === template.id &&
          JOINABLE.has(contest.status),
      );
    }
    return this.contests.find((contest) => contest.matchId === matchId && contest.templateId === template.id);
  }

  private insertContest(template: ContestTemplateRecord, matchId: string, lockTime: string, now: Date): ContestRecord {
    if (this.findCurrent(matchId, template) && template.contestType === "HEAD_TO_HEAD") {
      throw new AppError("CONTEST_CONFLICT", 409, "An open contest already exists for this match and template");
    }
    if (template.contestType !== "HEAD_TO_HEAD" && this.findCurrent(matchId, template)) {
      throw new AppError("CONTEST_CONFLICT", 409, "This template already has its instance for the match");
    }
    const nowIso = now.toISOString();
    const contest: ContestRecord = {
      id: newId(),
      templateId: template.id,
      matchId,
      contestType: template.contestType,
      status: "OPEN",
      capacity: template.capacity,
      filledCount: 0,
      entryFeeBaseUnits: template.entryFeeBaseUnits,
      currency: "USDC",
      rulesSnapshot: this.snapshot(template, matchId, lockTime),
      createdAt: nowIso,
      updatedAt: nowIso,
      lockedAt: null,
      completedAt: null,
      confirmedCount: 0,
      escrowPda: null,
      vaultAddress: null,
      usdcMint: null,
    };
    this.contests.push(contest);
    return contest;
  }

  private snapshot(template: ContestTemplateRecord, matchId: string, lockTime: string): RulesSnapshot {
    const payout = this.payouts.find(
      (row) => row.id === template.payoutPolicyId && row.version === template.payoutPolicyVersion,
    );
    const fee = this.fees.find((row) => row.id === template.feePolicyId && row.version === template.feePolicyVersion);
    if (!payout || !fee) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return {
      templateId: template.id,
      templateCode: template.templateCode,
      templateVersion: template.version,
      entryFeeBaseUnits: template.entryFeeBaseUnits,
      capacity: template.capacity,
      contestType: template.contestType,
      payoutPolicyId: payout.id,
      payoutPolicyVersion: payout.version,
      payoutPolicyType: payout.policyType,
      payoutConfiguration: clone(payout.configuration),
      feePolicyId: fee.id,
      feePolicyVersion: fee.version,
      feeRateBps: fee.rateBps,
      feeConfiguration: clone(fee.configuration),
      scoringRulesetId: DEV_SCORING_SNAPSHOT.scoringRulesetId,
      scoringRulesetVersion: DEV_SCORING_SNAPSHOT.scoringRulesetVersion,
      scoringRulesetName: DEV_SCORING_SNAPSHOT.scoringRulesetName,
      matchId,
      lockTime,
      currency: "USDC",
    };
  }

  private activeEntry(contestId: string, wallet: string): EntryRecord | undefined {
    return this.entries.find(
      (entry) =>
        entry.contestId === contestId &&
        entry.wallet === wallet &&
        (entry.status === "PENDING" || entry.status === "CONFIRMED"),
    );
  }

  private pendingReservation(contestId: string, teamVersionId: string): ReservationRecord | undefined {
    return this.reservations.find(
      (reservation) =>
        reservation.contestId === contestId &&
        reservation.teamVersionId === teamVersionId &&
        (reservation.status === "PENDING" || reservation.status === "CONFIRMED"),
    );
  }

  private assertLimits(contest: ContestRecord, wallet: string, limits: ContestLimits): void {
    const active = (entry: EntryRecord) => entry.status === "PENDING" || entry.status === "CONFIRMED";
    if (limits.maxEntriesPerContest !== null) {
      const count = this.entries.filter(
        (entry) => entry.contestId === contest.id && entry.wallet === wallet && active(entry),
      ).length;
      if (count >= limits.maxEntriesPerContest) {
        throw new AppError("ENTRY_LIMIT", 409, "Contest entry limit reached");
      }
    }
    if (limits.maxEntriesPerMatch !== null) {
      const contestIds = new Set(
        this.contests.filter((row) => row.matchId === contest.matchId).map((row) => row.id),
      );
      const count = this.entries.filter(
        (entry) => contestIds.has(entry.contestId) && entry.wallet === wallet && active(entry),
      ).length;
      if (count >= limits.maxEntriesPerMatch) {
        throw new AppError("ENTRY_LIMIT", 409, "Match entry limit reached");
      }
    }
    if (limits.maxExposurePerMatch !== null) {
      const contestIds = new Set(
        this.contests.filter((row) => row.matchId === contest.matchId).map((row) => row.id),
      );
      let exposure = 0;
      for (const entry of this.entries) {
        if (!contestIds.has(entry.contestId) || entry.wallet !== wallet || !active(entry)) {
          continue;
        }
        const reservation = this.reservations.find((row) => row.id === entry.reservationId);
        exposure += reservation?.amountBaseUnits ?? 0;
      }
      if (exposure + contest.entryFeeBaseUnits > limits.maxExposurePerMatch) {
        throw new AppError("ENTRY_LIMIT", 409, "Match exposure limit reached");
      }
    }
  }
}
