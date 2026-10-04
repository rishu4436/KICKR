/**
 * Phase 6.1 local fixture: football data only through the REAL scoring → settlement path.
 * Does NOT inject winners, payouts, or result hashes.
 */
import { InMemoryAuditStore } from "../../audit/memory.js";
import { InMemoryFootballStore } from "../../football/store.js";
import { FootballService } from "../../football/service.js";
import { InMemoryContestStore } from "../../contests/memory-store.js";
import { ContestService } from "../../contests/service.js";
import { ContestDiscoveryCache } from "../../contests/discovery.js";
import { InMemoryRedis } from "../../redis/client.js";
import { buildPhase5ReplayCatalog, LOCAL_DEV_REPLAY_MATCH } from "../../sports/replay-fixture.js";
import { seedProviderIdMapFromCatalog, InMemoryProviderIdMap } from "../../sports/id-map.js";
import { LiveScoringPipeline } from "../../live/pipeline.js";
import { LiveScoreCache } from "../../live/cache.js";
import { LiveScoreHub } from "../../live/hub.js";
import { LiveMetrics } from "../../live/metrics.js";
import { createContestScoringSource } from "../../live/contest-scoring-source.js";
import {
  buildDraftSnapshot,
  InMemorySnapshotStore,
  type ResultSnapshotRecord,
} from "../../live/snapshot.js";
import { InMemorySettlementStore } from "../../settlement/memory-store.js";
import { SettlementService } from "../../settlement/service.js";
import { SettlementOrchestrator } from "../../settlement/orchestrator.js";
import { DEV_V1_RULESET } from "../../domain/scoring/dev-v1.js";
import { newId } from "../../shared/ids.js";
import type { RequestContext } from "../../auth/types.js";
import type { NormalizedEventDraft } from "../../sports/normalize.js";
import type { ContestType } from "../../contests/types.js";
import { Keypair } from "@solana/web3.js";

export const FIXTURE_NOW = new Date("2026-10-02T17:30:00.000Z");

export function fixtureCtx(correlationId = "phase6.1"): RequestContext {
  return { now: FIXTURE_NOW, correlationId };
}

function draftEvent(
  partial: Partial<NormalizedEventDraft> & Pick<NormalizedEventDraft, "providerEventId" | "eventType" | "sequence" | "primaryExternalPlayerId">,
): NormalizedEventDraft {
  return {
    provider: "local-dev",
    externalFixtureId: "dev-fixture-replay",
    timestamp: "2026-10-02T15:12:00.000Z",
    timestampSource: "provider",
    matchMinute: 12,
    period: "1",
    secondaryExternalPlayerId: null,
    externalTeamId: "dev-club-a",
    correctionType: null,
    relatedProviderEventId: null,
    providerVersion: "phase6.1",
    rawEventHash: "c".repeat(64),
    metadata: {},
    requiresPrimaryPlayer: true,
    ...partial,
  };
}

export async function buildPhase61World(options?: {
  contestType?: ContestType;
  entrantCount?: number;
  /** When true, every entry uses the same XI/captain/vice so ties are possible. */
  identicalTeams?: boolean;
  /** Drop catalog replay events so only ingested events score. */
  clearCatalogEvents?: boolean;
}) {
  const contestType = options?.contestType ?? "HEAD_TO_HEAD";
  const entrantCount = options?.entrantCount ?? (contestType === "HEAD_TO_HEAD" ? 2 : 4);
  const identicalTeams = options?.identicalTeams ?? false;
  const catalog = buildPhase5ReplayCatalog();
  const audit = new InMemoryAuditStore();
  const footballStore = new InMemoryFootballStore(catalog);
  await footballStore.upsertCatalog(catalog);
  if (options?.clearCatalogEvents) {
    (footballStore as unknown as { events: unknown[] }).events = [];
  }
  const football = new FootballService(footballStore, audit, { creditCap: 100, maxPlayersFromOneTeam: null });
  const contestStore = new InMemoryContestStore();
  const contests = new ContestService(
    contestStore,
    football,
    audit,
    new ContestDiscoveryCache(new InMemoryRedis(), "test"),
    {
      reservationTtlSeconds: 600,
      maxEntriesPerMatch: null,
      maxEntriesPerContest: null,
      maxExposurePerMatch: null,
    },
  );
  const snapshots = new InMemorySnapshotStore();
  const settlementStore = new InMemorySettlementStore();
  const settlements = new SettlementService(settlementStore);
  const orchestrator = new SettlementOrchestrator(settlements, contestStore, snapshots);

  const idMap = new InMemoryProviderIdMap();
  seedProviderIdMapFromCatalog(idMap, "local-dev", catalog);
  idMap.set({
    provider: "local-dev",
    entityKind: "fixture",
    externalId: "dev-fixture-replay",
    kickrId: LOCAL_DEV_REPLAY_MATCH,
  });

  const metrics = new LiveMetrics();
  metrics.setProvider("local-dev", true);
  const pipeline = new LiveScoringPipeline(
    footballStore,
    idMap,
    new LiveScoreCache(new InMemoryRedis(), "test"),
    new LiveScoreHub(),
    metrics,
    audit,
    "local-dev",
    createContestScoringSource(contestStore),
  );

  const goal = catalog.players.find((row) => row.shortName === "AF1")!;
  const assist = catalog.players.find((row) => row.shortName === "AM1")!;
  const baseXi = catalog.players.slice(0, 11).map((row) => row.id);
  baseXi[0] = goal.id;
  baseXi[1] = assist.id;

  const wallets = Array.from({ length: entrantCount }, () => Keypair.generate());
  const versions: Array<{
    accountId: string;
    wallet: string;
    teamId: string;
    versionAId: string;
    versionBId: string;
    captainId: string;
    viceId: string;
    xi: string[];
  }> = [];

  for (let i = 0; i < entrantCount; i += 1) {
    const accountId = newId();
    const wallet = wallets[i]!.publicKey.toBase58();
    const teamId = newId();
    const xi = [...baseXi];
    if (!identicalTeams && i > 0) {
      const alt = catalog.players.find((row) => row.shortName === "AM2");
      if (alt && !xi.includes(alt.id)) {
        xi[2] = alt.id;
      }
    }
    const captainId = identicalTeams || i === 0 ? goal.id : assist.id;
    const viceId = identicalTeams || i === 0 ? assist.id : goal.id;
    await footballStore.createTeam({
      id: teamId,
      accountId,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      status: "DRAFT",
      createdAt: "2026-10-02T14:00:00.000Z",
      updatedAt: "2026-10-02T14:00:00.000Z",
    });
    const versionAId = newId();
    await footballStore.insertVersion({
      id: versionAId,
      teamId,
      version: 1,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      playerIds: xi,
      captainId,
      viceId,
      creditsUsed: 90,
      validationResult: { valid: true, errors: [] },
      createdAt: "2026-10-02T14:00:00.000Z",
    });
    const versionBId = newId();
    await footballStore.insertVersion({
      id: versionBId,
      teamId,
      version: 2,
      matchId: LOCAL_DEV_REPLAY_MATCH,
      playerIds: xi,
      captainId: viceId,
      viceId: captainId,
      creditsUsed: 90,
      validationResult: { valid: true, errors: [] },
      createdAt: "2026-10-02T14:05:00.000Z",
    });
    versions.push({ accountId, wallet, teamId, versionAId, versionBId, captainId, viceId, xi });
  }

  const templateCode =
    contestType === "HEAD_TO_HEAD" ? "H2H-5" : contestType === "GRAND_LEAGUE" ? "GRAND-5" : "WTA-20";
  const templates = await contestStore.listEnabledTemplates();
  const template = templates.find((row) => row.templateCode === templateCode && row.enabled);
  if (!template) throw new Error(`template ${templateCode} missing`);

  const ctx = fixtureCtx();
  const contest = await contests.ensureOpenContest(LOCAL_DEV_REPLAY_MATCH, template.id, ctx);

  const entries = [];
  for (let i = 0; i < entrantCount; i += 1) {
    const v = versions[i]!;
    const reservation = await contests.reserve(contest.id, v.accountId, v.wallet, v.versionAId, ctx);
    const sig = `fixture-deposit-${i}-${newId()}`;
    await contestStore.submitDeposit(reservation.reservation.id, sig, FIXTURE_NOW);
    const confirmed = await contestStore.confirmVerifiedDeposit({
      reservationId: reservation.reservation.id,
      signature: sig,
      slot: 1000 + i,
      blockTime: Math.floor(FIXTURE_NOW.getTime() / 1000),
      amountBaseUnits: contest.entryFeeBaseUnits,
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      vault: "FixtureVault1111111111111111111111111111111",
      contestPda: "FixtureContest111111111111111111111111111",
      depositReceipt: `receipt-${i}`,
      teamVersionId: v.versionAId,
      now: FIXTURE_NOW,
    });
    entries.push(confirmed.entry);
  }

  return {
    catalog,
    football,
    footballStore,
    contests,
    contestStore,
    contest,
    entries,
    versions,
    wallets,
    snapshots,
    settlements,
    settlementStore,
    orchestrator,
    pipeline,
    audit,
    goal,
    assist,
    idMap,
  };
}

export async function ingestScoringEvents(
  world: Awaited<ReturnType<typeof buildPhase61World>>,
  mode: "default" | "tie" = "default",
): Promise<void> {
  const ctx = fixtureCtx("ingest");
  if (mode === "tie") {
    // No events → identical zero scores; ranking uses entry_id_asc only.
    await world.pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx);
    return;
  }
  await world.pipeline.acceptNormalized(
    draftEvent({
      providerEventId: "p61-goal",
      eventType: "GOAL",
      sequence: 1,
      primaryExternalPlayerId: world.goal.providerId,
    }),
    { matchId: LOCAL_DEV_REPLAY_MATCH, ctx },
  );
  await world.pipeline.acceptNormalized(
    draftEvent({
      providerEventId: "p61-assist",
      eventType: "ASSIST",
      sequence: 2,
      primaryExternalPlayerId: world.assist.providerId,
      timestamp: "2026-10-02T15:12:01.000Z",
    }),
    { matchId: LOCAL_DEV_REPLAY_MATCH, ctx },
  );
  await world.pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx);
}

export async function createAndApproveSnapshots(
  world: Awaited<ReturnType<typeof buildPhase61World>>,
): Promise<ResultSnapshotRecord[]> {
  const ctx = fixtureCtx("snapshot");
  const recompute = await world.pipeline.recomputeMatch(LOCAL_DEV_REPLAY_MATCH, ctx);
  const byEntry = new Map(recompute.contestEntryScores.map((row) => [row.entryId, row]));
  const approvedRows: ResultSnapshotRecord[] = [];
  for (const entry of world.entries) {
    const score = byEntry.get(entry.id);
    if (!score) throw new Error(`missing contest score for ${entry.id}`);
    const owned = await world.footballStore.getVersionById(entry.teamVersionId);
    if (!owned) throw new Error("team version missing");
    const expectedA = world.versions.find((row) => row.wallet === entry.wallet)?.versionAId;
    if (entry.teamVersionId !== expectedA) {
      throw new Error("entry must freeze Version A");
    }
    if (entry.teamVersionId === world.versions.find((row) => row.wallet === entry.wallet)?.versionBId) {
      throw new Error("must not settle Version B");
    }
    const draft = buildDraftSnapshot({
      matchId: LOCAL_DEV_REPLAY_MATCH,
      contestId: world.contest.id,
      entryId: entry.id,
      version: owned.version,
      finalScoreMilliPoints: score.milliPoints,
      ranking: null,
      playerScores: score.players,
      dataFinalizationState: "FINAL",
      nowIso: ctx.now.toISOString(),
    });
    await world.snapshots.insertDraft(draft);
    approvedRows.push(await world.snapshots.approve(draft.id, ctx.now.toISOString()));
  }
  return approvedRows;
}

export { LOCAL_DEV_REPLAY_MATCH, DEV_V1_RULESET };
