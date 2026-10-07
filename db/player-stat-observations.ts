import type { Queryable } from "./types.js";
import type {
  PlayerStatObservation,
  PlayerStatObservationStore,
} from "../sports/shot-synthesis.js";
import { SHOT_ON_TARGET_STAT } from "../sports/shot-synthesis.js";
import { asString } from "./mappers.js";

type Row = Record<string, unknown>;

export function createPgPlayerStatObservationStore(db: Queryable): PlayerStatObservationStore {
  return {
    async getObservation(fixtureId, playerId, statType) {
      const result = await db.query<Row>(
        `SELECT fixture_id, player_id, stat_type, observed_total, updated_at
         FROM player_stat_observations
         WHERE fixture_id = $1 AND player_id = $2 AND stat_type = $3`,
        [fixtureId, playerId, statType],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        fixtureId: asString(row.fixture_id),
        playerId: asString(row.player_id),
        statType: SHOT_ON_TARGET_STAT,
        observedTotal: Number(row.observed_total),
        updatedAt:
          row.updated_at instanceof Date
            ? row.updated_at.toISOString()
            : asString(row.updated_at),
      };
    },
    async upsertObservation(row: PlayerStatObservation) {
      await db.query(
        `INSERT INTO player_stat_observations (fixture_id, player_id, stat_type, observed_total, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (fixture_id, player_id, stat_type)
         DO UPDATE SET observed_total = EXCLUDED.observed_total, updated_at = EXCLUDED.updated_at`,
        [row.fixtureId, row.playerId, row.statType, row.observedTotal, row.updatedAt],
      );
    },
  };
}
