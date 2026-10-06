import type pg from "pg";
import type { FreeContestResult, FreeResultRow, FreeResultStore } from "./results.js";

type Row = Record<string, unknown>;

function asString(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected string");
  return value;
}

export function createPgFreeResultStore(pool: pg.Pool): FreeResultStore {
  return {
    async getByContest(contestId: string): Promise<FreeContestResult | null> {
      const client = await pool.connect();
      try {
        const result = await client.query(
          `SELECT id, contest_id, match_id, status, rows, finalized_at
           FROM free_contest_results WHERE contest_id = $1`,
          [contestId],
        );
        const row = result.rows[0] as Row | undefined;
        if (!row) return null;
        return {
          id: asString(row.id),
          contestId: asString(row.contest_id),
          matchId: asString(row.match_id),
          status: "FINAL",
          rows: row.rows as FreeResultRow[],
          finalizedAt: new Date(asString(row.finalized_at)).toISOString(),
          merkleRoot: null,
          settlementHash: null,
          claimable: false,
        };
      } finally {
        client.release();
      }
    },

    async save(result: FreeContestResult): Promise<FreeContestResult> {
      const client = await pool.connect();
      try {
        await client.query(
          `INSERT INTO free_contest_results (id, contest_id, match_id, status, rows, finalized_at, created_at)
           VALUES ($1, $2, $3, 'FINAL', $4::jsonb, $5, $5)
           ON CONFLICT (contest_id) DO NOTHING`,
          [
            result.id,
            result.contestId,
            result.matchId,
            JSON.stringify(result.rows),
            result.finalizedAt,
          ],
        );
        const existing = await client.query(
          `SELECT id, contest_id, match_id, status, rows, finalized_at
           FROM free_contest_results WHERE contest_id = $1`,
          [result.contestId],
        );
        const row = existing.rows[0] as Row;
        return {
          id: asString(row.id),
          contestId: asString(row.contest_id),
          matchId: asString(row.match_id),
          status: "FINAL",
          rows: row.rows as FreeResultRow[],
          finalizedAt: new Date(asString(row.finalized_at)).toISOString(),
          merkleRoot: null,
          settlementHash: null,
          claimable: false,
        };
      } finally {
        client.release();
      }
    },
  };
}
