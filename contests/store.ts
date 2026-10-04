import type { ContestLimits, ContestRecord, ContestTemplateRecord, EntryRecord, OutboxRecord, ReservationRecord } from "./types.js";

export interface ConfirmDepositInput {
  reservationId: string;
  signature: string;
  slot: number;
  blockTime: number | null;
  amountBaseUnits: number;
  mint: string;
  vault: string;
  depositReceipt: string;
  contestPda: string;
  teamVersionId: string;
  now: Date;
}

export interface ConfirmDepositResult {
  contest: ContestRecord;
  reservation: ReservationRecord;
  entry: EntryRecord;
  idempotent: boolean;
}

export interface DepositHealth {
  pendingReservations: number;
  pendingEntries: number;
  submittedDeposits: number;
  rejectedDeposits: number;
  verifiedDeposits: number;
  reconciliationMismatches: number;
}

export interface EnsureResult {
  contest: ContestRecord;
  created: boolean;
}

export interface ReserveResult {
  contest: ContestRecord;
  reservation: ReservationRecord;
  entry: EntryRecord;
  nextContest: ContestRecord | null;
  filled: boolean;
}

export interface ReserveSeatInput {
  contestId: string;
  wallet: string;
  teamVersionId: string;
  now: Date;
  ttlSeconds: number;
  limits: ContestLimits;
}

/**
 * Authoritative contest persistence. Implementations must allocate seats with a
 * conditional update inside a transaction. Redis is not this store.
 */
export interface ContestStore {
  listEnabledTemplates(): Promise<ContestTemplateRecord[]>;
  getTemplate(id: string): Promise<ContestTemplateRecord | null>;
  /**
   * Development template edit. Does not rewrite any contest snapshot.
   * TODO: production template edits and who may make them are unspecified.
   */
  updateTemplate(
    id: string,
    patch: { entryFeeBaseUnits?: number; enabled?: boolean },
    now: Date,
  ): Promise<ContestTemplateRecord>;
  /** Always throws. Snapshots have no update path. */
  replaceSnapshot(contestId: string, snapshot: ContestRecord["rulesSnapshot"]): Promise<never>;
  ensureJoinable(matchId: string, templateId: string, lockTime: string, now: Date): Promise<EnsureResult>;
  reserveSeat(input: ReserveSeatInput): Promise<ReserveResult>;
  getContest(id: string): Promise<ContestRecord | null>;
  listDiscoverable(matchId: string): Promise<ContestRecord[]>;
  listByMatch(matchId: string): Promise<ContestRecord[]>;
  listEntries(contestId: string): Promise<EntryRecord[]>;
  getEntry(id: string): Promise<EntryRecord | null>;
  getReservation(id: string, now: Date): Promise<ReservationRecord | null>;
  lockJoinableForMatch(matchId: string, now: Date): Promise<ContestRecord[]>;
  listUnpublishedOutbox(): Promise<OutboxRecord[]>;
  markOutboxPublished(ids: readonly string[], now: Date): Promise<void>;
  findReservationByNonceHash(hash: string): Promise<ReservationRecord | null>;
  submitDeposit(reservationId: string, signature: string, now: Date): Promise<ReservationRecord>;
  confirmVerifiedDeposit(input: ConfirmDepositInput): Promise<ConfirmDepositResult>;
  recordRejection(input: { signature: string; reason: string; reservationId: string | null }): Promise<void>;
  depositHealth(): Promise<DepositHealth>;
}
