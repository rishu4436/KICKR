/**
 * Explicit provider → KICKR id resolution.
 * Never creates fake players. Unresolved mappings are recorded for diagnostics.
 */

export type ProviderEntityKind = "player" | "club" | "fixture";

export interface ProviderIdMapping {
  provider: string;
  entityKind: ProviderEntityKind;
  externalId: string;
  kickrId: string;
}

export interface ProviderIdMap {
  get(provider: string, entityKind: ProviderEntityKind, externalId: string): string | null;
  set(mapping: ProviderIdMapping): void;
  list(): ProviderIdMapping[];
}

export class InMemoryProviderIdMap implements ProviderIdMap {
  private readonly rows = new Map<string, ProviderIdMapping>();

  private key(provider: string, entityKind: ProviderEntityKind, externalId: string): string {
    return `${provider}|${entityKind}|${externalId}`;
  }

  get(provider: string, entityKind: ProviderEntityKind, externalId: string): string | null {
    return this.rows.get(this.key(provider, entityKind, externalId))?.kickrId ?? null;
  }

  set(mapping: ProviderIdMapping): void {
    this.rows.set(this.key(mapping.provider, mapping.entityKind, mapping.externalId), { ...mapping });
  }

  list(): ProviderIdMapping[] {
    return [...this.rows.values()].map((row) => ({ ...row }));
  }
}

/** Seed maps from existing catalog columns (provider_id / external_fixture_id). */
export function seedProviderIdMapFromCatalog(
  map: ProviderIdMap,
  provider: string,
  catalog: {
    clubs: Array<{ id: string; providerId: string }>;
    players: Array<{ id: string; providerId: string }>;
    matches: Array<{ id: string; externalFixtureId: string }>;
  },
): void {
  for (const club of catalog.clubs) {
    map.set({ provider, entityKind: "club", externalId: club.providerId, kickrId: club.id });
  }
  for (const player of catalog.players) {
    map.set({ provider, entityKind: "player", externalId: player.providerId, kickrId: player.id });
  }
  for (const match of catalog.matches) {
    map.set({
      provider,
      entityKind: "fixture",
      externalId: match.externalFixtureId,
      kickrId: match.id,
    });
  }
}
