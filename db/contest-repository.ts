import type pg from "pg";
import { transition } from "../domain/state-machine.js";
import type { ContestState } from "../domain/state-machine.js";
import { DEV_SCORING_SNAPSHOT } from "../contests/dev-catalog.js";
import type { ContestStore, EnsureResult, ReserveResult, ReserveSeatInput } from "../contests/store.js";
import type {
  ContestRecord,
  ContestTemplateRecord,
  ContestType,
  EntryRecord,
  EntryStatus,
  ReservationRecord,
  ReservationStatus,
  RulesSnapshot,
} from "../contests/types.js";
import { ESCROW_PLACEHOLDER } from "../contests/types.js";
import { confirmationAllowed } from "../contests/expiry.js";
import { nonceHash, toHex } from "../solana/escrow.js";
import { AppError } from "../shared/errors.js";
import { newId, newNonce } from "../shared/ids.js";
import { asDate, asString } from "./mappers.js";
import { withTransaction } from "./pool.js";
import type { Queryable } from "./types.js";

type Row = Record<string, unknown>;

function asInt(value: unknown): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "string" && /^-?\d+$/.test(value)) {
    return Number(value);
  }
  throw new Error("Expected an integer");
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

function contestType(value: string): ContestType {
  if (value === "HEAD_TO_HEAD" || value === "WINNER_TAKES_ALL" || value === "GRAND_LEAGUE") {
    return value;
  }
  throw new Error("unknown contest type");
}

function contestStatus(value: string): ContestState {
  return value as ContestState;
}

function templateFrom(row: Row): ContestTemplateRecord {
  return {
    id: asString(row.id),
    templateCode: asString(row.template_code),
    contestType: contestType(asString(row.contest_type)),
    entryFeeBaseUnits: asInt(row.entry_fee_base_units),
    capacity: asInt(row.capacity),
    payoutPolicyId: asString(row.payout_policy_id),
    payoutPolicyVersion: asInt(row.payout_policy_version),
    feePolicyId: asString(row.fee_policy_id),
    feePolicyVersion: asInt(row.fee_policy_version),
    currency: "USDC",
    enabled: row.enabled === true,
    version: asInt(row.version),
    createdAt: asDate(row.created_at).toISOString(),
    updatedAt: asDate(row.updated_at).toISOString(),
  };
}

function contestFrom(row: Row): ContestRecord {
  const snapshot = asObject(row.rules_snapshot) as unknown as RulesSnapshot;
  return {
    id: asString(row.id),
    templateId: asString(row.template_id),
    matchId: asString(row.match_id),
    contestType: contestType(asString(row.contest_type)),
    status: contestStatus(asString(row.status)),
    capacity: asInt(row.capacity),
    filledCount: asInt(row.filled_count),
    entryFeeBaseUnits: asInt(row.entry_fee_base_units),
    currency: "USDC",
    rulesSnapshot: snapshot,
    createdAt: asDate(row.created_at).toISOString(),
    updatedAt: asDate(row.updated_at).toISOString(),
    lockedAt: row.locked_at == null ? null : asDate(row.locked_at).toISOString(),
    completedAt: row.completed_at == null ? null : asDate(row.completed_at).toISOString(),
    confirmedCount: row.confirmed_count == null ? 0 : asInt(row.confirmed_count),
    escrowPda: row.escrow_pda == null ? null : asString(row.escrow_pda),
    vaultAddress: row.vault_address == null ? null : asString(row.vault_address),
    usdcMint: row.usdc_mint == null ? null : asString(row.usdc_mint),
  };
}

function reservationFrom(row: Row): ReservationRecord {
  return {
    id: asString(row.id),
    contestId: asString(row.contest_id),
    wallet: asString(row.wallet),
    teamVersionId: asString(row.team_version_id),
    amountBaseUnits: asInt(row.amount_base_units),
    currency: "USDC",
    nonce: asString(row.nonce),
    escrowPlaceholder: asObject(row.escrow_placeholder) as unknown as ReservationRecord["escrowPlaceholder"],
    issuedAt: asDate(row.issued_at).toISOString(),
    expiresAt: asDate(row.expires_at).toISOString(),
    status: asString(row.status) as ReservationStatus,
    nonceHash: row.nonce_hash == null ? "" : asString(row.nonce_hash),
    depositSignature: row.deposit_signature == null ? null : asString(row.deposit_signature),
    submittedAt: row.submitted_at == null ? null : asDate(row.submitted_at).toISOString(),
    confirmationStatus: (row.confirmation_status == null ? "NONE" : asString(row.confirmation_status)) as ReservationRecord["confirmationStatus"],
    createdAt: asDate(row.created_at).toISOString(),
    updatedAt: asDate(row.updated_at).toISOString(),
  };
}

function entryFrom(row: Row): EntryRecord {
  return {
    id: asString(row.id),
    contestId: asString(row.contest_id),
    wallet: asString(row.wallet),
    teamVersionId: asString(row.team_version_id),
    reservationId: asString(row.reservation_id),
    status: asString(row.status) as EntryStatus,
    seatNumber: asInt(row.seat_number),
    joinedAt: asDate(row.joined_at).toISOString(),
    confirmationStatus: (row.confirmation_status == null ? "PENDING" : asString(row.confirmation_status)) as EntryRecord["confirmationStatus"],
    depositSignature: row.deposit_signature == null ? null : asString(row.deposit_signature),
    confirmedSlot: row.confirmed_slot == null ? null : asInt(row.confirmed_slot),
    confirmedBlockTime: row.confirmed_block_time == null ? null : asDate(row.confirmed_block_time).toISOString(),
    chainAmountBaseUnits: row.chain_amount_base_units == null ? null : asInt(row.chain_amount_base_units),
    mint: row.mint == null ? null : asString(row.mint),
    vaultAddress: row.vault_address == null ? null : asString(row.vault_address),
    depositReceipt: row.deposit_receipt == null ? null : asString(row.deposit_receipt),
    createdAt: asDate(row.created_at).toISOString(),
    updatedAt: asDate(row.updated_at).toISOString(),
  };
}

const CONTEST_COLUMNS = `id, template_id, match_id, contest_type, status, capacity, filled_count,
  entry_fee_base_units, currency, rules_snapshot, created_at, updated_at, locked_at, completed_at,
  confirmed_count, escrow_pda, vault_address, usdc_mint`;

async function loadTemplate(db: Queryable, id: string): Promise<ContestTemplateRecord | null> {
  const result = await db.query<Row>(
    `SELECT id, template_code, contest_type, entry_fee_base_units, capacity,
            payout_policy_id, payout_policy_version, fee_policy_id, fee_policy_version,
            currency, enabled, version, created_at, updated_at
     FROM contest_templates WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row ? templateFrom(row) : null;
}

async function buildSnapshot(db: Queryable, template: ContestTemplateRecord, matchId: string, lockTime: string): Promise<RulesSnapshot> {
  const payout = await db.query<Row>(
    `SELECT id, version, policy_type, configuration FROM payout_policies WHERE id = $1 AND version = $2`,
    [template.payoutPolicyId, template.payoutPolicyVersion],
  );
  const fee = await db.query<Row>(
    `SELECT id, version, rate_bps, configuration FROM fee_policies WHERE id = $1 AND version = $2`,
    [template.feePolicyId, template.feePolicyVersion],
  );
  const payoutRow = payout.rows[0];
  const feeRow = fee.rows[0];
  if (!payoutRow || !feeRow) {
    throw new AppError("NOT_FOUND", 404, "Not found");
  }
  return {
    templateId: template.id,
    templateCode: template.templateCode,
    templateVersion: template.version,
    entryFeeBaseUnits: template.entryFeeBaseUnits,
    capacity: template.capacity,
    contestType: template.contestType,
    payoutPolicyId: asString(payoutRow.id),
    payoutPolicyVersion: asInt(payoutRow.version),
    payoutPolicyType: contestType(asString(payoutRow.policy_type)),
    payoutConfiguration: asObject(payoutRow.configuration),
    feePolicyId: asString(feeRow.id),
    feePolicyVersion: asInt(feeRow.version),
    feeRateBps: asInt(feeRow.rate_bps),
    feeConfiguration: asObject(feeRow.configuration),
    scoringRulesetId: DEV_SCORING_SNAPSHOT.scoringRulesetId,
    scoringRulesetVersion: DEV_SCORING_SNAPSHOT.scoringRulesetVersion,
    scoringRulesetName: DEV_SCORING_SNAPSHOT.scoringRulesetName,
    matchId,
    lockTime,
    currency: "USDC",
  };
}

async function insertContest(
  db: Queryable,
  template: ContestTemplateRecord,
  matchId: string,
  lockTime: string,
  now: Date,
): Promise<ContestRecord> {
  const snapshot = await buildSnapshot(db, template, matchId, lockTime);
  const id = newId();
  const nowIso = now.toISOString();
  await db.query(
    `INSERT INTO contests (
       id, template_id, match_id, contest_type, status, capacity, filled_count,
       entry_fee_base_units, currency, rules_snapshot, created_at, updated_at, locked_at, completed_at
     ) VALUES (
       $1, $2, $3, $4, 'OPEN', $5, 0, $6, 'USDC', $7::jsonb, $8, $8, NULL, NULL
     )`,
    [id, template.id, matchId, template.contestType, template.capacity, template.entryFeeBaseUnits, JSON.stringify(snapshot), nowIso],
  );
  return {
    id,
    templateId: template.id,
    matchId,
    contestType: template.contestType,
    status: "OPEN",
    capacity: template.capacity,
    filledCount: 0,
    entryFeeBaseUnits: template.entryFeeBaseUnits,
    currency: "USDC",
    rulesSnapshot: snapshot,
    createdAt: nowIso,
    updatedAt: nowIso,
    lockedAt: null,
    completedAt: null,
    confirmedCount: 0,
    escrowPda: null,
    vaultAddress: null,
    usdcMint: null,
  };
}

/**
 * Postgres implementation of the contest store.
 * Seat allocation is a conditional UPDATE inside a transaction after FOR UPDATE.
 * TODO: scoring ruleset on the snapshot is DEV_V1 until a production ruleset is selected.
 */
export function createPgContestStore(pool: pg.Pool): ContestStore {
  const db = {
    async query<T = Row>(sql: string, params?: readonly unknown[]) {
      const client = await pool.connect();
      try {
        const result = await client.query(sql, params ? [...params] : undefined);
        return { rows: result.rows as T[], rowCount: result.rowCount };
      } finally {
        client.release();
      }
    },
  };

  return {
    async listEnabledTemplates() {
      const result = await db.query<Row>(
        `SELECT id, template_code, contest_type, entry_fee_base_units, capacity,
                payout_policy_id, payout_policy_version, fee_policy_id, fee_policy_version,
                currency, enabled, version, created_at, updated_at
         FROM contest_templates WHERE enabled = true ORDER BY template_code`,
      );
      return result.rows.map(templateFrom);
    },
    async getTemplate(id) {
      return loadTemplate(db, id);
    },
    async updateTemplate(id, patch, now) {
      const current = await loadTemplate(db, id);
      if (!current) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
      const fee = patch.entryFeeBaseUnits ?? current.entryFeeBaseUnits;
      const enabled = patch.enabled ?? current.enabled;
      const result = await db.query<Row>(
        `UPDATE contest_templates
         SET entry_fee_base_units = $2, enabled = $3, version = version + 1, updated_at = $4
         WHERE id = $1
         RETURNING id, template_code, contest_type, entry_fee_base_units, capacity,
                   payout_policy_id, payout_policy_version, fee_policy_id, fee_policy_version,
                   currency, enabled, version, created_at, updated_at`,
        [id, fee, enabled, now.toISOString()],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError("NOT_FOUND", 404, "Not found");
      }
      return templateFrom(row);
    },
    async replaceSnapshot() {
      throw new Error("contest rules_snapshot is immutable");
    },
    async ensureJoinable(matchId, templateId, lockTime, now): Promise<EnsureResult> {
      return withTransaction(pool, async (tx) => {
        const template = await loadTemplate(tx, templateId);
        if (!template || !template.enabled) {
          throw new AppError("NOT_FOUND", 404, "Not found");
        }
        const joinable = await tx.query<Row>(
          `SELECT ${CONTEST_COLUMNS} FROM contests
           WHERE match_id = $1 AND template_id = $2 AND status IN ('OPEN', 'PARTIALLY_FILLED')
           FOR UPDATE`,
          [matchId, templateId],
        );
        const open = joinable.rows[0];
        if (open && template.contestType === "HEAD_TO_HEAD") {
          return { contest: contestFrom(open), created: false };
        }
        if (template.contestType !== "HEAD_TO_HEAD") {
          const any = await tx.query<Row>(
            `SELECT ${CONTEST_COLUMNS} FROM contests WHERE match_id = $1 AND template_id = $2 LIMIT 1`,
            [matchId, templateId],
          );
          const existing = any.rows[0];
          if (existing) {
            return { contest: contestFrom(existing), created: false };
          }
        } else if (open) {
          return { contest: contestFrom(open), created: false };
        }
        await tx.query("SAVEPOINT kickr_ensure_contest");
        try {
          const contest = await insertContest(tx, template, matchId, lockTime, now);
          await tx.query("RELEASE SAVEPOINT kickr_ensure_contest");
          return { contest, created: true };
        } catch (error) {
          await tx.query("ROLLBACK TO SAVEPOINT kickr_ensure_contest");
          if (!isUniqueViolation(error)) {
            throw error;
          }
          const again = await tx.query<Row>(
            `SELECT ${CONTEST_COLUMNS} FROM contests
             WHERE match_id = $1 AND template_id = $2
               AND (
                 contest_type <> 'HEAD_TO_HEAD'
                 OR status IN ('OPEN', 'PARTIALLY_FILLED')
               )
             ORDER BY created_at DESC LIMIT 1`,
            [matchId, templateId],
          );
          const row = again.rows[0];
          if (!row) {
            throw error;
          }
          return { contest: contestFrom(row), created: false };
        }
      });
    },
    async reserveSeat(input: ReserveSeatInput): Promise<ReserveResult> {
      return withTransaction(pool, async (tx) => {
        const selected = await tx.query<Row>(
          `SELECT ${CONTEST_COLUMNS} FROM contests WHERE id = $1 FOR UPDATE`,
          [input.contestId],
        );
        const row = selected.rows[0];
        if (!row) {
          throw new AppError("NOT_FOUND", 404, "Not found");
        }
        const contest = contestFrom(row);
        if (contest.status === "FULL" || contest.filledCount >= contest.capacity) {
          throw new AppError("CONTEST_FULL", 409, "Contest is full", { details: { refresh: true } });
        }
        if (contest.status !== "OPEN" && contest.status !== "PARTIALLY_FILLED") {
          throw new AppError("CONTEST_NOT_JOINABLE", 409, "Contest is not open for reservations");
        }
        await assertLimits(tx, contest, input.wallet, input.limits);
        const dupWallet = await tx.query(
          `SELECT id FROM contest_entries
           WHERE contest_id = $1 AND wallet = $2 AND status IN ('PENDING', 'CONFIRMED')`,
          [contest.id, input.wallet],
        );
        if ((dupWallet.rowCount ?? 0) > 0) {
          throw new AppError("DUPLICATE_ENTRY", 409, "Wallet already has a seat in this contest");
        }
        const dupTeam = await tx.query(
          `SELECT id FROM contest_reservations
           WHERE contest_id = $1 AND team_version_id = $2 AND status IN ('PENDING', 'CONFIRMED')`,
          [contest.id, input.teamVersionId],
        );
        if ((dupTeam.rowCount ?? 0) > 0) {
          throw new AppError("DUPLICATE_RESERVATION", 409, "Team version already has a reservation in this contest");
        }
        const nextStatus = (contest.filledCount + 1 === contest.capacity ? "FULL" : "PARTIALLY_FILLED") as ContestState;
        const status = transition("CONTEST", contest.status, nextStatus) as ContestState;
        const updated = await tx.query(
          `UPDATE contests
           SET filled_count = filled_count + 1, status = $2, updated_at = $3
           WHERE id = $1 AND filled_count < capacity AND status = $4`,
          [contest.id, status, input.now.toISOString(), contest.status],
        );
        if ((updated.rowCount ?? 0) !== 1) {
          throw new AppError("CONTEST_FULL", 409, "Contest is full", { details: { refresh: true } });
        }
        const nowIso = input.now.toISOString();
        const reservationId = newId();
        const entryId = newId();
        const nonce = newNonce();
        const expires = new Date(input.now.getTime() + input.ttlSeconds * 1000).toISOString();
        const seatNumber = contest.filledCount + 1;
        await tx.query(
          `INSERT INTO contest_reservations (
             id, contest_id, wallet, team_version_id, amount_base_units, currency, nonce,
             escrow_placeholder, issued_at, expires_at, status, nonce_hash, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,'USDC',$6,$7::jsonb,$8,$9,'PENDING',$10,$8,$8)`,
          [reservationId, contest.id, input.wallet, input.teamVersionId, contest.entryFeeBaseUnits, nonce, JSON.stringify(ESCROW_PLACEHOLDER), nowIso, expires, toHex(nonceHash(nonce))],
        );
        await tx.query(
          `INSERT INTO contest_entries (
             id, contest_id, wallet, team_version_id, reservation_id, status, seat_number, joined_at, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,'PENDING',$6,$7,$7,$7)`,
          [entryId, contest.id, input.wallet, input.teamVersionId, reservationId, seatNumber, nowIso],
        );
        let nextContest: ContestRecord | null = null;
        if (status === "FULL" && contest.contestType === "HEAD_TO_HEAD") {
          await tx.query(
            `INSERT INTO contest_outbox (id, event_type, contest_id, payload, created_at)
             VALUES ($1, 'CONTEST_FILLED', $2, $3::jsonb, $4)`,
            [newId(), contest.id, JSON.stringify({ matchId: contest.matchId, templateId: contest.templateId, capacity: contest.capacity }), nowIso],
          );
          const template = await loadTemplate(tx, contest.templateId);
          if (!template) {
            throw new AppError("NOT_FOUND", 404, "Not found");
          }
          nextContest = await insertContest(tx, template, contest.matchId, contest.rulesSnapshot.lockTime, input.now);
        }
        const stored = await tx.query<Row>(`SELECT ${CONTEST_COLUMNS} FROM contests WHERE id = $1`, [contest.id]);
        const saved = stored.rows[0];
        if (!saved) {
          throw new AppError("NOT_FOUND", 404, "Not found");
        }
        return {
          contest: contestFrom(saved),
          reservation: {
            id: reservationId,
            contestId: contest.id,
            wallet: input.wallet,
            teamVersionId: input.teamVersionId,
            amountBaseUnits: contest.entryFeeBaseUnits,
            currency: "USDC",
            nonce,
            escrowPlaceholder: { ...ESCROW_PLACEHOLDER },
            issuedAt: nowIso,
            expiresAt: expires,
            status: "PENDING",
            nonceHash: toHex(nonceHash(nonce)),
            depositSignature: null,
            submittedAt: null,
            confirmationStatus: "NONE",
            createdAt: nowIso,
            updatedAt: nowIso,
          },
          entry: {
            id: entryId,
            contestId: contest.id,
            wallet: input.wallet,
            teamVersionId: input.teamVersionId,
            reservationId,
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
          },
          nextContest,
          filled: status === "FULL",
        };
      });
    },
    async getContest(id) {
      const result = await db.query<Row>(`SELECT ${CONTEST_COLUMNS} FROM contests WHERE id = $1`, [id]);
      const row = result.rows[0];
      return row ? contestFrom(row) : null;
    },
    async listDiscoverable(matchId) {
      const result = await db.query<Row>(
        `SELECT ${CONTEST_COLUMNS} FROM contests
         WHERE match_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED')
         ORDER BY contest_type, entry_fee_base_units, created_at`,
        [matchId],
      );
      return result.rows.map(contestFrom);
    },
    async listWithConfirmedEntry(matchId, wallet) {
      const result = await db.query<Row>(
        `SELECT ${CONTEST_COLUMNS} FROM contests
         WHERE match_id = $1
           AND id IN (
             SELECT contest_id FROM contest_entries
             WHERE wallet = $2 AND status = 'CONFIRMED'
           )
         ORDER BY contest_type, entry_fee_base_units, created_at`,
        [matchId, wallet],
      );
      return result.rows.map(contestFrom);
    },
    async listByMatch(matchId) {
      const result = await db.query<Row>(
        `SELECT ${CONTEST_COLUMNS} FROM contests WHERE match_id = $1 ORDER BY created_at`,
        [matchId],
      );
      return result.rows.map(contestFrom);
    },
    async listContests() {
      const result = await db.query<Row>(
        `SELECT ${CONTEST_COLUMNS} FROM contests ORDER BY created_at`,
      );
      return result.rows.map(contestFrom);
    },
    async listEntries(contestId) {
      const result = await db.query<Row>(
        `SELECT id, contest_id, wallet, team_version_id, reservation_id, status, seat_number, joined_at,
                confirmation_status, deposit_signature, confirmed_slot, confirmed_block_time, chain_amount_base_units,
                mint, vault_address, deposit_receipt, created_at, updated_at
         FROM contest_entries WHERE contest_id = $1 ORDER BY seat_number`,
        [contestId],
      );
      return result.rows.map(entryFrom);
    },
    async getEntry(id) {
      const result = await db.query<Row>(
        `SELECT id, contest_id, wallet, team_version_id, reservation_id, status, seat_number, joined_at,
                confirmation_status, deposit_signature, confirmed_slot, confirmed_block_time, chain_amount_base_units,
                mint, vault_address, deposit_receipt, created_at, updated_at
         FROM contest_entries WHERE id = $1`,
        [id],
      );
      const row = result.rows[0];
      return row ? entryFrom(row) : null;
    },
    async getReservation(id, now) {
      return withTransaction(pool, async (tx) => {
        const result = await tx.query<Row>(
          `SELECT id, contest_id, wallet, team_version_id, amount_base_units, currency, nonce,
                  escrow_placeholder, issued_at, expires_at, status, created_at, updated_at
           FROM contest_reservations WHERE id = $1 FOR UPDATE`,
          [id],
        );
        const row = result.rows[0];
        if (!row) {
          return null;
        }
        const reservation = reservationFrom(row);
        if (reservation.status === "PENDING" && Date.parse(reservation.expiresAt) <= now.getTime()) {
          await tx.query(
            `UPDATE contest_reservations SET status = 'EXPIRED', updated_at = $2 WHERE id = $1 AND status = 'PENDING'`,
            [id, now.toISOString()],
          );
          reservation.status = "EXPIRED";
          reservation.updatedAt = now.toISOString();
        }
        return reservation;
      });
    },
    async lockJoinableForMatch(matchId, now) {
      return withTransaction(pool, async (tx) => {
        const result = await tx.query<Row>(
          `SELECT ${CONTEST_COLUMNS} FROM contests
           WHERE match_id = $1 AND status IN ('OPEN', 'PARTIALLY_FILLED', 'FULL')
           FOR UPDATE`,
          [matchId],
        );
        const locked: ContestRecord[] = [];
        for (const row of result.rows) {
          const contest = contestFrom(row);
          const status = transition("CONTEST", contest.status, "LOCKED") as ContestState;
          await tx.query(
            `UPDATE contests SET status = $2, locked_at = $3, updated_at = $3 WHERE id = $1`,
            [contest.id, status, now.toISOString()],
          );
          locked.push({ ...contest, status, lockedAt: now.toISOString(), updatedAt: now.toISOString() });
        }
        return locked;
      });
    },
    async listUnpublishedOutbox() {
      const result = await db.query<Row>(
        `SELECT id, event_type, contest_id, payload, created_at, published_at
         FROM contest_outbox WHERE published_at IS NULL ORDER BY created_at`,
      );
      return result.rows.map((row) => ({
        id: asString(row.id),
        eventType: "CONTEST_FILLED" as const,
        contestId: asString(row.contest_id),
        payload: asObject(row.payload),
        createdAt: asDate(row.created_at).toISOString(),
        publishedAt: row.published_at ? asDate(row.published_at).toISOString() : null,
      }));
    },
    async markOutboxPublished(ids, now) {
      if (ids.length === 0) {
        return;
      }
      await db.query(
        `UPDATE contest_outbox SET published_at = $2 WHERE id = ANY($1::uuid[]) AND published_at IS NULL`,
        [ids, now.toISOString()],
      );
    },

    async findReservationByNonceHash(hash) {
      const result = await db.query<Row>(
        `SELECT id, contest_id, wallet, team_version_id, amount_base_units, currency, nonce,
                escrow_placeholder, issued_at, expires_at, status, nonce_hash, deposit_signature,
                submitted_at, confirmation_status, created_at, updated_at
         FROM contest_reservations WHERE nonce_hash = $1`,
        [hash],
      );
      const row = result.rows[0];
      return row ? reservationFrom(row) : null;
    },
    async submitDeposit(reservationId, signature, now) {
      const result = await db.query<Row>(
        `UPDATE contest_reservations
         SET deposit_signature = $2, submitted_at = $3, confirmation_status = 'SUBMITTED', updated_at = $3
         WHERE id = $1 AND status = 'PENDING' AND expires_at > $3
         RETURNING id, contest_id, wallet, team_version_id, amount_base_units, currency, nonce,
                   escrow_placeholder, issued_at, expires_at, status, nonce_hash, deposit_signature,
                   submitted_at, confirmation_status, created_at, updated_at`,
        [reservationId, signature, now.toISOString()],
      );
      const row = result.rows[0];
      if (!row) {
        throw new AppError("RESERVATION_EXPIRED", 409, "Expired reservation cannot become valid");
      }
      return reservationFrom(row);
    },
    async confirmVerifiedDeposit(input) {
      return withTransaction(pool, async (tx) => {
        const selected = await tx.query<Row>(
          `SELECT e.id FROM contest_entries e WHERE e.reservation_id = $1 FOR UPDATE`,
          [input.reservationId],
        );
        if (!selected.rows[0]) {
          throw new AppError("NOT_FOUND", 404, "Not found");
        }
        const current = await tx.query<Row>(
          `SELECT status, deposit_signature, team_version_id FROM contest_entries WHERE reservation_id = $1`,
          [input.reservationId],
        );
        const entryRow = current.rows[0];
        if (!entryRow) {
          throw new AppError("NOT_FOUND", 404, "Not found");
        }
        if (asString(entryRow.team_version_id) !== input.teamVersionId) {
          throw new AppError("TEAM_VERSION_MISMATCH", 409, "Entry team version does not match the deposit");
        }
        if (asString(entryRow.status) === "CONFIRMED" && asString(entryRow.deposit_signature) === input.signature) {
          const reservation = await tx.query<Row>(
            `SELECT id, contest_id, wallet, team_version_id, amount_base_units, currency, nonce,
                    escrow_placeholder, issued_at, expires_at, status, nonce_hash, deposit_signature,
                    submitted_at, confirmation_status, created_at, updated_at
             FROM contest_reservations WHERE id = $1`,
            [input.reservationId],
          );
          const contest = await tx.query<Row>(`SELECT ${CONTEST_COLUMNS} FROM contests WHERE id = (SELECT contest_id FROM contest_reservations WHERE id = $1)`, [input.reservationId]);
          const entry = await tx.query<Row>(
            `SELECT id, contest_id, wallet, team_version_id, reservation_id, status, seat_number, joined_at,
                    confirmation_status, deposit_signature, confirmed_slot, confirmed_block_time, chain_amount_base_units,
                    mint, vault_address, deposit_receipt, created_at, updated_at
             FROM contest_entries WHERE reservation_id = $1`,
            [input.reservationId],
          );
          return {
            contest: contestFrom(contest.rows[0] as Row),
            reservation: reservationFrom(reservation.rows[0] as Row),
            entry: entryFrom(entry.rows[0] as Row),
            idempotent: true,
          };
        }
        const reservationState = await tx.query<Row>(
          `SELECT status, expires_at FROM contest_reservations WHERE id = $1`,
          [input.reservationId],
        );
        const reservationRow = reservationState.rows[0];
        if (!reservationRow) {
          throw new AppError("NOT_FOUND", 404, "Not found");
        }
        const reservationStatus = asString(reservationRow.status);
        const expiresAt = asDate(reservationRow.expires_at).toISOString();
        if (reservationStatus !== "CONFIRMED" && !confirmationAllowed({
          reservationStatus,
          expiresAt,
          blockTime: input.blockTime,
          now: input.now,
        })) {
          await tx.query(
            `UPDATE contest_reservations SET status = 'EXPIRED', updated_at = $2
             WHERE id = $1 AND status = 'PENDING'`,
            [input.reservationId, input.now.toISOString()],
          );
          throw new AppError("RESERVATION_EXPIRED", 409, "Expired reservation cannot become valid");
        }
        const nowIso = input.now.toISOString();
        const blockTime = input.blockTime === null ? null : new Date(input.blockTime * 1000).toISOString();
        const updatedEntry = await tx.query(
          `UPDATE contest_entries
           SET status = 'CONFIRMED', confirmation_status = 'CONFIRMED', deposit_signature = $2,
               confirmed_slot = $3, confirmed_block_time = $4, chain_amount_base_units = $5,
               mint = $6, vault_address = $7, deposit_receipt = $8, updated_at = $9
           WHERE reservation_id = $1 AND status = 'PENDING' AND team_version_id = $10`,
          [input.reservationId, input.signature, input.slot, blockTime, input.amountBaseUnits, input.mint, input.vault, input.depositReceipt, nowIso, input.teamVersionId],
        );
        if ((updatedEntry.rowCount ?? 0) !== 1) {
          throw new AppError("DUPLICATE", 409, "Deposit already recorded");
        }
        const updatedReservation = await tx.query(
          `UPDATE contest_reservations
           SET status = 'CONFIRMED', confirmation_status = 'VERIFIED', deposit_signature = $2, updated_at = $3
           WHERE id = $1 AND status IN ('PENDING', 'EXPIRED')`,
          [input.reservationId, input.signature, nowIso],
        );
        if ((updatedReservation.rowCount ?? 0) !== 1) {
          throw new AppError("RESERVATION_EXPIRED", 409, "Expired reservation cannot become valid");
        }
        await tx.query(
          `UPDATE contests c
           SET confirmed_count = confirmed_count + 1, escrow_pda = $2, vault_address = $3, usdc_mint = $4, updated_at = $5
           FROM contest_reservations r
           WHERE r.id = $1 AND c.id = r.contest_id`,
          [input.reservationId, input.contestPda, input.vault, input.mint, nowIso],
        );
        const reservation = await tx.query<Row>(
          `SELECT id, contest_id, wallet, team_version_id, amount_base_units, currency, nonce,
                  escrow_placeholder, issued_at, expires_at, status, nonce_hash, deposit_signature,
                  submitted_at, confirmation_status, created_at, updated_at
           FROM contest_reservations WHERE id = $1`,
          [input.reservationId],
        );
        const contest = await tx.query<Row>(`SELECT ${CONTEST_COLUMNS} FROM contests WHERE id = (SELECT contest_id FROM contest_reservations WHERE id = $1)`, [input.reservationId]);
        const entry = await tx.query<Row>(
          `SELECT id, contest_id, wallet, team_version_id, reservation_id, status, seat_number, joined_at,
                  confirmation_status, deposit_signature, confirmed_slot, confirmed_block_time, chain_amount_base_units,
                  mint, vault_address, deposit_receipt, created_at, updated_at
           FROM contest_entries WHERE reservation_id = $1`,
          [input.reservationId],
        );
        return {
          contest: contestFrom(contest.rows[0] as Row),
          reservation: reservationFrom(reservation.rows[0] as Row),
          entry: entryFrom(entry.rows[0] as Row),
          idempotent: false,
        };
      });
    },
    async recordRejection(input) {
      await db.query(
        `INSERT INTO deposit_reconciliations (
           id, signature, status, reason, reservation_id, created_at
         ) VALUES ($1, $2, 'REJECTED', $3, $4, now())
         ON CONFLICT (signature) DO NOTHING`,
        [newId(), input.signature, input.reason, input.reservationId],
      );
    },
    async depositHealth() {
      const pendingReservations = await db.query(`SELECT id FROM contest_reservations WHERE status = 'PENDING'`);
      const pendingEntries = await db.query(`SELECT id FROM contest_entries WHERE status = 'PENDING'`);
      const submitted = await db.query(`SELECT id FROM contest_reservations WHERE confirmation_status = 'SUBMITTED'`);
      const rejected = await db.query(`SELECT id FROM deposit_reconciliations WHERE status = 'REJECTED'`);
      const verified = await db.query(`SELECT id FROM contest_entries WHERE status = 'CONFIRMED'`);
      return {
        pendingReservations: pendingReservations.rowCount ?? 0,
        pendingEntries: pendingEntries.rowCount ?? 0,
        submittedDeposits: submitted.rowCount ?? 0,
        rejectedDeposits: rejected.rowCount ?? 0,
        verifiedDeposits: verified.rowCount ?? 0,
        reconciliationMismatches: rejected.rowCount ?? 0,
      };
    },
  };
}

async function assertLimits(
  tx: Queryable,
  contest: ContestRecord,
  wallet: string,
  limits: ReserveSeatInput["limits"],
): Promise<void> {
  if (limits.maxEntriesPerContest !== null) {
    const count = await tx.query(
      `SELECT id FROM contest_entries WHERE contest_id = $1 AND wallet = $2 AND status IN ('PENDING', 'CONFIRMED')`,
      [contest.id, wallet],
    );
    if ((count.rowCount ?? 0) >= limits.maxEntriesPerContest) {
      throw new AppError("ENTRY_LIMIT", 409, "Contest entry limit reached");
    }
  }
  if (limits.maxEntriesPerMatch !== null) {
    const count = await tx.query(
      `SELECT e.id FROM contest_entries e
       JOIN contests c ON c.id = e.contest_id
       WHERE c.match_id = $1 AND e.wallet = $2 AND e.status IN ('PENDING', 'CONFIRMED')`,
      [contest.matchId, wallet],
    );
    if ((count.rowCount ?? 0) >= limits.maxEntriesPerMatch) {
      throw new AppError("ENTRY_LIMIT", 409, "Match entry limit reached");
    }
  }
  if (limits.maxExposurePerMatch !== null) {
    const sum = await tx.query<Row>(
      `SELECT COALESCE(SUM(r.amount_base_units), 0) AS exposure
       FROM contest_entries e
       JOIN contests c ON c.id = e.contest_id
       JOIN contest_reservations r ON r.id = e.reservation_id
       WHERE c.match_id = $1 AND e.wallet = $2 AND e.status IN ('PENDING', 'CONFIRMED')`,
      [contest.matchId, wallet],
    );
    const exposure = asInt(sum.rows[0]?.exposure ?? 0);
    if (exposure + contest.entryFeeBaseUnits > limits.maxExposurePerMatch) {
      throw new AppError("ENTRY_LIMIT", 409, "Match exposure limit reached");
    }
  }
}

