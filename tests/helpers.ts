import nacl from "tweetnacl";
import bs58 from "bs58";
import { InMemoryAuditStore } from "../audit/memory.js";
import { InMemoryAccountRepository, InMemoryNonceRepository, InMemorySessionRepository } from "../auth/memory.js";
import { AuthService } from "../auth/service.js";
import type { AppConfig } from "../config/types.js";
import { InMemoryGrantRepository } from "../rbac/grants.js";
import { InMemoryRedis } from "../redis/client.js";
import type { Clock } from "../shared/clock.js";
import { silentLogger } from "../shared/logger.js";
import { createApp, type AppDeps } from "../api/server.js";
import { FootballService } from "../football/service.js";
import { InMemoryFootballStore } from "../football/store.js";
import { createLocalDevProvider } from "../sports/local-dev-provider.js";
import { ContestDiscoveryCache } from "../contests/discovery.js";
import { ContestService } from "../contests/service.js";
import { InMemoryContestStore } from "../contests/memory-store.js";
import { InMemoryFreeResultStore } from "../contests/free/results.js";
import { InMemorySettlementStore } from "../settlement/memory-store.js";
import { SettlementService } from "../settlement/service.js";
import { SettlementOrchestrator } from "../settlement/orchestrator.js";
import { InMemorySnapshotStore } from "../live/snapshot.js";
import { InMemoryAttestationStore } from "../attestation/memory-store.js";
import { createAttestorRegistry } from "../attestation/registry.js";
import { createAttestorVerifier } from "../attestation/verify.js";
import { createSettlementAttestationGate } from "../attestation/gate.js";
import { generateLocalDevAttestorKeypair, issueLocalDevAttestation } from "../attestation/local-dev.js";
import { hashFinalizedSnapshots } from "../attestation/canonical.js";
import { seedApprovedSnapshotsForSettlement } from "../attestation/test-harness.js";
import type { SettlementRecord } from "../settlement/types.js";
import { LOCAL_DEV_ATTESTOR_ID } from "../attestation/types.js";
import type { SettlementAttestationGate } from "../attestation/gate.js";
import type { AttestationStore } from "../attestation/types.js";

export function generateWallet(): { publicKey: string; secretKey: Uint8Array } {
  const pair = nacl.sign.keyPair();
  return { publicKey: bs58.encode(pair.publicKey), secretKey: pair.secretKey };
}

export function signMessage(message: string, secretKey: Uint8Array): string {
  const signature = nacl.sign.detached(new TextEncoder().encode(message), secretKey);
  return bs58.encode(signature);
}

export function testConfig(overrides?: {
  databaseUrl?: string;
  redisUrl?: string;
  solanaRpcUrl?: string;
  nodeEnv?: "production" | "development" | "test";
  origins?: readonly string[];
}): AppConfig {
  const nodeEnv = overrides?.nodeEnv ?? "test";
  return {
    public: {
      appName: "KICKR",
      environment: nodeEnv,
      authDomain: "localhost",
      solanaCluster: "devnet",
      escrowProgramId: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN",
      usdcMint: "",
      usdcDecimals: 6,
      sportsDataProvider: "unset",
      liveProviderConfigured: false,
    },
    server: {
      nodeEnv,
      port: 3000,
      logLevel: "error",
      auth: {
        domain: "localhost",
        nonceTtlSeconds: 300,
        sessionTtlSeconds: 3600,
      },
      rateLimit: { authMax: 30, authWindowSeconds: 60 },
      origins: overrides?.origins ?? [],
      solana: {
        cluster: "devnet",
        escrowProgramId: "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN",
        usdcMint: "",
        usdcDecimals: 6,
      },
      sportsData: {
        provider: "unset",
        liveProvider: "none",
        pollIntervalSeconds: 15,
        requestTimeoutMs: 8000,
        liveProviderConfigured: false,
      },
      fantasy: { creditCap: 100, maxPlayersFromOneTeam: null },
      contests: {
        reservationTtlSeconds: 600,
        maxEntriesPerMatch: null,
        maxEntriesPerContest: null,
        maxExposurePerMatch: null,
      },
      attestation: {
        approvedAttestorsRaw: "",
      },
    },
    secrets: {
      databaseUrl: overrides?.databaseUrl ?? "postgres://kickr:supersecretpassword@localhost:5432/kickr",
      redisUrl: overrides?.redisUrl ?? "redis://:redis-secret-password@localhost:6379",
      solanaRpcUrl: overrides?.solanaRpcUrl ?? "https://rpc.example/?api-key=solana-secret-key",
      sportsApiKey: null,
      sportsApiUrl: "https://api.sportmonks.com/v3",
    },
  };
}

export function buildTestApp(clock: Clock): {
  app: ReturnType<typeof createApp>;
  deps: AppDeps;
  grants: InMemoryGrantRepository;
  audit: InMemoryAuditStore;
  attestations: AttestationStore;
  attestationGate: SettlementAttestationGate;
  localDevAttestor: ReturnType<typeof generateLocalDevAttestorKeypair>;
} {
  const localDevAttestor = generateLocalDevAttestorKeypair();
  const config = testConfig();
  config.server.attestation.approvedAttestorsRaw = `${LOCAL_DEV_ATTESTOR_ID}:${localDevAttestor.publicKeyHex}`;
  const audit = new InMemoryAuditStore();
  const auth = new AuthService(
    new InMemoryAccountRepository(),
    new InMemoryNonceRepository(),
    new InMemorySessionRepository(),
    audit,
    config.server.auth,
  );
  const grants = new InMemoryGrantRepository();
  const football = new FootballService(
    new InMemoryFootballStore(createLocalDevProvider().catalog()),
    audit,
    config.server.fantasy,
  );
  const redis = new InMemoryRedis();
  const contestStore = new InMemoryContestStore();
  const freeResults = new InMemoryFreeResultStore();
  const contests = new ContestService(
    contestStore,
    football,
    audit,
    new ContestDiscoveryCache(redis, config.public.environment),
    config.server.contests,
    undefined,
    true,
    freeResults,
  );
  const snapshots = new InMemorySnapshotStore();
  const attestations = new InMemoryAttestationStore();
  const registry = createAttestorRegistry([
    { id: LOCAL_DEV_ATTESTOR_ID, publicKey: localDevAttestor.publicKey, localDevOnly: true },
  ]);
  const gateEnv = config.server.nodeEnv;
  const verifier = createAttestorVerifier(registry, gateEnv);
  const attestationGate = createSettlementAttestationGate({
    store: attestations,
    snapshots,
    verifier,
    registry,
    audit,
    nodeEnv: gateEnv,
  });
  const settlement = new SettlementService(new InMemorySettlementStore(), attestationGate);
  const settlementOrchestrator = new SettlementOrchestrator(settlement, contestStore, snapshots);
  const deps: AppDeps = {
    config,
    auth,
    grants,
    audit,
    football,
    contests,
    settlement,
    settlementOrchestrator,
    snapshots,
    attestations,
    attestationGate,
    redis,
    logger: silentLogger(),
    clock,
  };
  return { app: createApp(deps), deps, grants, audit, attestations, attestationGate, localDevAttestor };
}

/** Issue a LOCAL_DEV attestation bound to the test app's stores for approve/prepare. */
export async function issueTestAttestationForSettlement(
  deps: AppDeps,
  localDevAttestor: ReturnType<typeof generateLocalDevAttestorKeypair>,
  settlement: SettlementRecord,
  nowIso: string,
): Promise<void> {
  if (!deps.snapshots || !deps.attestations) {
    throw new Error("test app missing snapshots/attestations");
  }
  const rows = deps.settlement ? await deps.settlement.getLeaderboard(settlement.id) : [];
  await seedApprovedSnapshotsForSettlement(deps.snapshots, settlement, rows, nowIso);
  const approved = await deps.snapshots.listApprovedForContest(settlement.contestId);
  const signEnv = deps.config.server.nodeEnv === "production" ? "development" : deps.config.server.nodeEnv;
  const attestation = issueLocalDevAttestation({
    matchId: settlement.matchId,
    contestId: settlement.contestId,
    scoringRulesetId: settlement.rulesetName,
    scoringRulesetVersion: settlement.rulesetVersion,
    finalizedSnapshotHash: hashFinalizedSnapshots(approved),
    resultHash: settlement.resultHash,
    issuedAt: nowIso,
    secretKey: localDevAttestor.secretKey,
    nodeEnv: signEnv,
  });
  await deps.attestations.insert(attestation);
}
