import type pg from "pg";
import { AppError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import { asIsoTimestamp, asJsonArray, asNumber, asString } from "../db/mappers.js";
import type { LeagueStore } from "./memory-store.js";
import type {
  PrivateLeagueMember,
  PrivateLeagueRecord,
  PrivateLeagueResult,
  PrivateLeagueResultRow,
  PrivateLeagueStatus,
} from "./types.js";

type Row = Record<string, unknown>;

function mapLeague(row: Row): PrivateLeagueRecord {
  return {
    id: asString(row.id),
    name: asString(row.name),
    matchId: asString(row.match_id),
    ownerAccountId: asString(row.owner_account_id),
    ownerWallet: asString(row.owner_wallet),
    inviteCode: asString(row.invite_code),
    capacity: asNumber(row.capacity),
    memberCount: asNumber(row.member_count),
    status: asString(row.status) as PrivateLeagueStatus,
    createdAt: asIsoTimestamp(row.created_at),
    updatedAt: asIsoTimestamp(row.updated_at),
  };
}

function mapMember(row: Row): PrivateLeagueMember {
  return {
    id: asString(row.id),
    leagueId: asString(row.league_id),
    accountId: asString(row.account_id),
    wallet: asString(row.wallet),
    teamVersionId: asString(row.team_version_id),
    joinedAt: asIsoTimestamp(row.joined_at),
  };
}

function mapResult(row: Row): PrivateLeagueResult {
  return {
    id: asString(row.id),
    leagueId: asString(row.league_id),
    matchId: asString(row.match_id),
    status: "FINAL",
    rows: asJsonArray<PrivateLeagueResultRow>(row.rows),
    finalizedAt: asIsoTimestamp(row.finalized_at),
  };
}

export function createPgLeagueStore(pool: pg.Pool): LeagueStore {
  return {
    async createLeague(input) {
      const id = newId();
      const iso = input.now.toISOString();
      const client = await pool.connect();
      try {
        const result = await client.query(
          `INSERT INTO private_leagues (
             id, name, match_id, owner_account_id, owner_wallet, invite_code,
             capacity, member_count, status, created_at, updated_at
           ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,'OPEN',$8,$8)
           RETURNING *`,
          [
            id,
            input.name,
            input.matchId,
            input.ownerAccountId,
            input.ownerWallet,
            input.inviteCode,
            input.capacity,
            iso,
          ],
        );
        return mapLeague(result.rows[0] as Row);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === "23505") {
          throw new AppError("INVITE_COLLISION", 409, "Invite code collision — retry");
        }
        throw error;
      } finally {
        client.release();
      }
    },

    async getById(id) {
      const result = await pool.query(`SELECT * FROM private_leagues WHERE id = $1`, [id]);
      const row = result.rows[0] as Row | undefined;
      return row ? mapLeague(row) : null;
    },

    async getByInviteCode(code) {
      const result = await pool.query(`SELECT * FROM private_leagues WHERE invite_code = $1`, [code]);
      const row = result.rows[0] as Row | undefined;
      return row ? mapLeague(row) : null;
    },

    async listByMatch(matchId) {
      const result = await pool.query(
        `SELECT * FROM private_leagues WHERE match_id = $1 ORDER BY created_at ASC`,
        [matchId],
      );
      return result.rows.map((row) => mapLeague(row as Row));
    },

    async listOwned(ownerAccountId) {
      const result = await pool.query(
        `SELECT * FROM private_leagues WHERE owner_account_id = $1 ORDER BY created_at DESC`,
        [ownerAccountId],
      );
      return result.rows.map((row) => mapLeague(row as Row));
    },

    async listJoined(wallet) {
      const result = await pool.query(
        `SELECT l.* FROM private_leagues l
         INNER JOIN private_league_members m ON m.league_id = l.id
         WHERE m.wallet = $1
         ORDER BY m.joined_at DESC`,
        [wallet],
      );
      return result.rows.map((row) => mapLeague(row as Row));
    },

    async join(input) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const locked = await client.query(
          `SELECT * FROM private_leagues WHERE id = $1 FOR UPDATE`,
          [input.leagueId],
        );
        const leagueRow = locked.rows[0] as Row | undefined;
        if (!leagueRow) {
          throw new AppError("NOT_FOUND", 404, "Not found");
        }
        const league = mapLeague(leagueRow);
        const dup = await client.query(
          `SELECT id FROM private_league_members
           WHERE league_id = $1 AND (wallet = $2 OR account_id = $3)`,
          [input.leagueId, input.wallet, input.accountId],
        );
        if (dup.rows[0]) {
          throw new AppError("DUPLICATE_JOIN", 409, "Already joined this league");
        }
        if (league.status !== "OPEN" || league.memberCount >= league.capacity) {
          throw new AppError("LEAGUE_FULL", 409, "League is full");
        }
        const memberId = newId();
        const joinedAt = input.now.toISOString();
        const memberRes = await client.query(
          `INSERT INTO private_league_members (id, league_id, account_id, wallet, team_version_id, joined_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING *`,
          [memberId, input.leagueId, input.accountId, input.wallet, input.teamVersionId, joinedAt],
        );
        const nextCount = league.memberCount + 1;
        const nextStatus = nextCount >= league.capacity ? "FULL" : "OPEN";
        const updated = await client.query(
          `UPDATE private_leagues
           SET member_count = $2, status = $3, updated_at = $4
           WHERE id = $1
           RETURNING *`,
          [input.leagueId, nextCount, nextStatus, joinedAt],
        );
        await client.query("COMMIT");
        return {
          league: mapLeague(updated.rows[0] as Row),
          member: mapMember(memberRes.rows[0] as Row),
          created: true,
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listMembers(leagueId) {
      const result = await pool.query(
        `SELECT * FROM private_league_members WHERE league_id = $1 ORDER BY joined_at ASC`,
        [leagueId],
      );
      return result.rows.map((row) => mapMember(row as Row));
    },

    async getMember(leagueId, wallet) {
      const result = await pool.query(
        `SELECT * FROM private_league_members WHERE league_id = $1 AND wallet = $2`,
        [leagueId, wallet],
      );
      const row = result.rows[0] as Row | undefined;
      return row ? mapMember(row) : null;
    },

    async setStatus(leagueId, status, now) {
      const result = await pool.query(
        `UPDATE private_leagues SET status = $2, updated_at = $3 WHERE id = $1 RETURNING *`,
        [leagueId, status, now.toISOString()],
      );
      const row = result.rows[0] as Row | undefined;
      return row ? mapLeague(row) : null;
    },

    async getResult(leagueId) {
      const result = await pool.query(
        `SELECT * FROM private_league_results WHERE league_id = $1`,
        [leagueId],
      );
      const row = result.rows[0] as Row | undefined;
      return row ? mapResult(row) : null;
    },

    async saveResult(result) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO private_league_results (id, league_id, match_id, status, rows, finalized_at, created_at)
           VALUES ($1,$2,$3,'FINAL',$4::jsonb,$5,$5)
           ON CONFLICT (league_id) DO NOTHING`,
          [
            result.id,
            result.leagueId,
            result.matchId,
            JSON.stringify(result.rows),
            result.finalizedAt,
          ],
        );
        await client.query(
          `UPDATE private_leagues SET status = 'COMPLETED', updated_at = $2 WHERE id = $1`,
          [result.leagueId, result.finalizedAt],
        );
        const existing = await client.query(
          `SELECT * FROM private_league_results WHERE league_id = $1`,
          [result.leagueId],
        );
        await client.query("COMMIT");
        return mapResult(existing.rows[0] as Row);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listResultsForWallet(wallet) {
      const result = await pool.query(
        `SELECT r.* FROM private_league_results r
         WHERE EXISTS (
           SELECT 1 FROM jsonb_array_elements(r.rows) elem
           WHERE elem->>'wallet' = $1
         )
         ORDER BY r.finalized_at DESC`,
        [wallet],
      );
      return result.rows.map((row) => mapResult(row as Row));
    },
  };
}
