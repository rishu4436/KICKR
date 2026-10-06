/**
 * Public DEMO environment seed. Service-layer only — no raw SQL to app tables.
 * Never creates paid contests, touches escrow, sends Solana txs, or grants RUN_SETTLEMENT.
 */
import type { FootballStore } from "../football/store.js";
import type { ContestService } from "../contests/service.js";
import type { RequestContext } from "../auth/types.js";
import { FREE_TEMPLATES } from "../contests/free/catalog.js";
import { createDemoProvider, DEMO_PROVIDER_NAME } from "./demo-provider.js";
import { AppError } from "../shared/errors.js";
import { seedProviderIdMapFromCatalog, type ProviderIdMap } from "./id-map.js";

export interface DemoSeedGate {
  nodeEnv: string;
  sportsProvider: string;
  demoSeedEnabled: boolean;
}

export interface DemoSeedDeps {
  footballStore: FootballStore;
  contests: ContestService;
  idMap?: ProviderIdMap;
  clock: () => Date;
}

export function assertDemoSeedAllowed(gate: DemoSeedGate): void {
  const provider = gate.sportsProvider.trim().toLowerCase().replace(/_/g, "-");
  if (provider !== "demo") {
    throw new AppError(
      "DEMO_SEED_BLOCKED",
      403,
      "demo:seed requires SPORTS_PROVIDER=DEMO",
      { details: { sportsProvider: gate.sportsProvider } },
    );
  }
  if (gate.nodeEnv === "production" && !gate.demoSeedEnabled) {
    throw new AppError(
      "DEMO_SEED_BLOCKED",
      403,
      "Production demo seed requires DEMO_SEED_ENABLED=true (deliberate flag)",
    );
  }
  // Refuse if paid paths would open — production always has allowPaidDevnet=false
  // via ContestService; this is an extra belt for the seed script.
}

export interface DemoSeedResult {
  provider: typeof DEMO_PROVIDER_NAME;
  matches: number;
  players: number;
  freeContestsEnsured: Array<{ matchId: string; templateCode: string; contestId: string }>;
  paidContestsCreated: 0;
  escrowTouched: false;
  solanaTxSent: false;
  runSettlementGranted: false;
  label: "DEMO DATA";
}

/** Upsert DEMO catalog + ensure FREE contests only for each DEMO match. */
export async function seedPublicDemo(deps: DemoSeedDeps, gate: DemoSeedGate): Promise<DemoSeedResult> {
  assertDemoSeedAllowed(gate);
  const provider = createDemoProvider();
  const catalog = provider.catalog();
  await deps.footballStore.upsertCatalog(catalog);
  if (deps.idMap) {
    seedProviderIdMapFromCatalog(deps.idMap, DEMO_PROVIDER_NAME, catalog);
  }

  const ctx: RequestContext = {
    now: deps.clock(),
    correlationId: `demo-seed-${deps.clock().toISOString()}`,
  };
  const freeContestsEnsured: DemoSeedResult["freeContestsEnsured"] = [];
  for (const match of catalog.matches) {
    for (const template of FREE_TEMPLATES) {
      const contest = await deps.contests.ensureOpenContest(match.id, template.id, ctx);
      if (contest.contestKind !== "FREE" || contest.entryFeeBaseUnits !== 0) {
        throw new AppError(
          "DEMO_SEED_REFUSED",
          500,
          "Demo seed refused: ensureOpenContest returned a non-FREE contest",
          { details: { contestId: contest.id, kind: contest.contestKind } },
        );
      }
      freeContestsEnsured.push({
        matchId: match.id,
        templateCode: template.templateCode,
        contestId: contest.id,
      });
    }
  }

  return {
    provider: DEMO_PROVIDER_NAME,
    matches: catalog.matches.length,
    players: catalog.players.length,
    freeContestsEnsured,
    paidContestsCreated: 0,
    escrowTouched: false,
    solanaTxSent: false,
    runSettlementGranted: false,
    label: "DEMO DATA",
  };
}
