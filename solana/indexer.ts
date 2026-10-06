import type { AuditStore } from "../audit/types.js";
import type { ContestStore } from "../contests/store.js";
import type { EntryRecord, ReservationRecord } from "../contests/types.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { EscrowClientConfig } from "./escrow.js";
import { decideDeposit, type DepositObservation } from "./verify.js";

export type DepositFetcher = (signature: string) => Promise<DepositObservation | null>;

export interface IndexerHealth {
  rpcErrors: number;
  unknownDeposits: number;
  verificationFailures: number;
  lastSuccessAt: string | null;
}

export type IndexerOutcome =
  | { outcome: "PENDING"; reason: "RPC_UNAVAILABLE" | "NOT_FINALIZED" | "DB_WRITE_FAILED" }
  | { outcome: "REJECTED"; reason: string }
  | { outcome: "CONFIRMED"; idempotent: boolean };

/**
 * Confirms an entry only after decideDeposit accepts a finalized observation
 * that matches the reservation nonce. A click, a reservation, a signature
 * alone, or a raw vault transfer never reaches ENTRY_CONFIRMED.
 * Postgres remains the reservation and entry record. This function does not
 * move tokens.
 */
export class DepositIndexer {
  /** Optional Phase 8 counters. Null keeps the indexer usable without them. */
  reliability: { hit(name: "deposit_verification_failures" | "dependency_timeouts"): void } | null = null;
  readonly health: IndexerHealth = {
    rpcErrors: 0,
    unknownDeposits: 0,
    verificationFailures: 0,
    lastSuccessAt: null,
  };

  constructor(
    private readonly store: ContestStore,
    private readonly audit: AuditStore,
    private readonly escrow: EscrowClientConfig,
    private readonly fetchObservation: DepositFetcher,
  ) {}

  async process(signature: string, now: Date, correlationId: string | null = null): Promise<IndexerOutcome> {
    let observation: DepositObservation | null;
    try {
      observation = await this.fetchObservation(signature);
    } catch {
      this.health.rpcErrors += 1;
      this.reliability?.hit("dependency_timeouts");
      return { outcome: "PENDING", reason: "RPC_UNAVAILABLE" };
    }
    if (!observation || observation.commitment !== "finalized") {
      return { outcome: "PENDING", reason: "NOT_FINALIZED" };
    }
    const reservation = await this.store.findReservationByNonceHash(observation.reservationNonceHash);
    const entry = reservation ? await this.entryFor(reservation) : null;
    const decision = decideDeposit({
      observation,
      programId: this.escrow.programId,
      mint: this.escrow.usdcMint,
      tokenProgram: this.escrow.tokenProgramId ?? TOKEN_PROGRAM_ID.toBase58(),
      reservation: reservation && entry
        ? {
            reservationId: reservation.id,
            contestId: reservation.contestId,
            wallet: reservation.wallet,
            teamVersionId: reservation.teamVersionId,
            amountBaseUnits: reservation.amountBaseUnits,
            nonce: reservation.nonce,
            expiresAt: reservation.expiresAt,
            status: reservation.status,
            entryStatus: entry.status,
            entryId: entry.id,
            existingSignature: entry.depositSignature,
          }
        : null,
    });
    if (!decision.ok) {
      if (decision.reason === "NOT_FINALIZED") {
        return { outcome: "PENDING", reason: "NOT_FINALIZED" };
      }
      this.health.verificationFailures += 1;
      this.reliability?.hit("deposit_verification_failures");
      const unknown = decision.reason === "UNKNOWN_RESERVATION";
      if (unknown) {
        this.health.unknownDeposits += 1;
      }
      await this.store.recordRejection({
        signature,
        reason: decision.reason,
        reservationId: unknown ? null : reservation?.id ?? null,
      });
      await this.audit.append({
        action: "DEPOSIT_REJECTED",
        occurredAt: now,
        entityType: "ENTRY",
        entityId: unknown ? signature : reservation?.id ?? signature,
        metadata: {
          reason: decision.reason,
          signature,
          attached: false,
          confirmed: false,
        },
        actorAccountId: null,
        actorWallet: observation.sender || null,
        correlationId,
      });
      return { outcome: "REJECTED", reason: decision.reason };
    }
    try {
      const confirmed = await this.store.confirmVerifiedDeposit({
        reservationId: decision.reservationId,
        signature: observation.signature,
        slot: observation.slot,
        blockTime: observation.blockTime,
        amountBaseUnits: observation.amountBaseUnits,
        mint: observation.mint,
        vault: observation.vault,
        depositReceipt: observation.depositReceipt,
        contestPda: observation.contestPda,
        teamVersionId: observation.teamVersionId,
        now,
      });
      if (!confirmed.idempotent) {
        await this.audit.append({
          action: "DEPOSIT_VERIFIED",
          occurredAt: now,
          entityType: "ENTRY",
          entityId: confirmed.entry.id,
          metadata: {
            signature: observation.signature,
            slot: observation.slot,
            commitment: "finalized",
            amountBaseUnits: observation.amountBaseUnits,
            mint: observation.mint,
            vault: observation.vault,
            depositReceipt: observation.depositReceipt,
            contestPda: observation.contestPda,
          },
          actorAccountId: null,
          actorWallet: observation.sender,
          correlationId,
        });
        await this.audit.append({
          action: "ENTRY_CONFIRMED",
          occurredAt: now,
          entityType: "ENTRY",
          entityId: confirmed.entry.id,
          metadata: {
            signature: observation.signature,
            slot: observation.slot,
            commitment: "finalized",
            teamVersionId: confirmed.entry.teamVersionId,
            contestId: confirmed.entry.contestId,
          },
          actorAccountId: null,
          actorWallet: observation.sender,
          correlationId,
        });
      }
      this.health.lastSuccessAt = now.toISOString();
      return { outcome: "CONFIRMED", idempotent: confirmed.idempotent };
    } catch {
      return { outcome: "PENDING", reason: "DB_WRITE_FAILED" };
    }
  }

  private async entryFor(reservation: ReservationRecord): Promise<EntryRecord | null> {
    const entries = await this.store.listEntries(reservation.contestId);
    return entries.find((entry) => entry.reservationId === reservation.id) ?? null;
  }
}
