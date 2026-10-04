import type { Queryable } from "./types.js";
import type { ProviderEntityKind, ProviderIdMapping } from "../sports/id-map.js";
import { asString } from "./mappers.js";

type Row = Record<string, unknown>;

export interface ProviderIdMapRepository {
  listAll(): Promise<ProviderIdMapping[]>;
  listByProvider(provider: string): Promise<ProviderIdMapping[]>;
  /**
   * Persist a mapping only when kickr_id already exists in the domain tables.
   * Never invents a player/club/fixture row.
   */
  upsertMapping(mapping: ProviderIdMapping): Promise<"upserted" | "rejected_missing_kickr">;
}

export function createPgProviderIdMapRepository(db: Queryable): ProviderIdMapRepository {
  return {
    async listAll() {
      const result = await db.query<Row>(
        `SELECT provider, entity_kind, external_id, kickr_id FROM provider_id_map`,
      );
      return result.rows.map(mapRow);
    },
    async listByProvider(provider: string) {
      const result = await db.query<Row>(
        `SELECT provider, entity_kind, external_id, kickr_id
         FROM provider_id_map WHERE provider = $1`,
        [provider],
      );
      return result.rows.map(mapRow);
    },
    async upsertMapping(mapping: ProviderIdMapping) {
      const exists = await kickrExists(db, mapping.entityKind, mapping.kickrId);
      if (!exists) {
        return "rejected_missing_kickr";
      }
      await db.query(
        `INSERT INTO provider_id_map (provider, entity_kind, external_id, kickr_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, entity_kind, external_id)
         DO UPDATE SET kickr_id = EXCLUDED.kickr_id`,
        [mapping.provider, mapping.entityKind, mapping.externalId, mapping.kickrId],
      );
      return "upserted";
    },
  };
}

export class InMemoryProviderIdMapRepository implements ProviderIdMapRepository {
  private readonly rows: ProviderIdMapping[] = [];
  constructor(
    private readonly exists: (kind: ProviderEntityKind, kickrId: string) => boolean = () => true,
  ) {}

  async listAll(): Promise<ProviderIdMapping[]> {
    return this.rows.map((row) => ({ ...row }));
  }

  async listByProvider(provider: string): Promise<ProviderIdMapping[]> {
    return this.rows.filter((row) => row.provider === provider).map((row) => ({ ...row }));
  }

  async upsertMapping(mapping: ProviderIdMapping): Promise<"upserted" | "rejected_missing_kickr"> {
    if (!this.exists(mapping.entityKind, mapping.kickrId)) {
      return "rejected_missing_kickr";
    }
    const index = this.rows.findIndex(
      (row) =>
        row.provider === mapping.provider &&
        row.entityKind === mapping.entityKind &&
        row.externalId === mapping.externalId,
    );
    if (index >= 0) {
      this.rows[index] = { ...mapping };
    } else {
      this.rows.push({ ...mapping });
    }
    return "upserted";
  }
}

function mapRow(row: Row): ProviderIdMapping {
  const entityKind = asString(row.entity_kind);
  if (entityKind !== "player" && entityKind !== "club" && entityKind !== "fixture") {
    throw new Error("unknown provider_id_map entity_kind");
  }
  return {
    provider: asString(row.provider),
    entityKind,
    externalId: asString(row.external_id),
    kickrId: asString(row.kickr_id),
  };
}

async function kickrExists(db: Queryable, kind: ProviderEntityKind, kickrId: string): Promise<boolean> {
  if (kind === "player") {
    const result = await db.query(`SELECT 1 FROM players WHERE id = $1`, [kickrId]);
    return result.rows.length > 0;
  }
  if (kind === "club") {
    const result = await db.query(`SELECT 1 FROM clubs WHERE id = $1`, [kickrId]);
    return result.rows.length > 0;
  }
  const result = await db.query(`SELECT 1 FROM matches WHERE id = $1`, [kickrId]);
  return result.rows.length > 0;
}
