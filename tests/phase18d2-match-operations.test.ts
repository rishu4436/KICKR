import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isAllowed } from "../rbac/authorize.js";
import { ROLE_PERMISSIONS } from "../rbac/matrix.js";
import { PERMISSIONS } from "../rbac/permissions.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";
import { resetMatchOpsServiceForTests } from "../api/match-ops.js";
import { createMatchOperationsService } from "../ops/match-operations.js";
import { InMemoryFootballStore } from "../football/store.js";
import { InMemoryAuditStore } from "../audit/memory.js";
import { LiveScoringService } from "../live/service.js";
import { FootballService } from "../football/service.js";
import { InMemoryRedis } from "../redis/client.js";
import { InMemoryProviderIdMap } from "../sports/id-map.js";
import {
  OPERATOR_PROVENANCE,
  OPERATOR_PROVIDER_NAME,
  isOperatorManagedDataSource,
} from "../sports/operator-provider.js";
import { DEMO_PROVIDER_NAME, buildDemoSingleMatchCatalog } from "../sports/demo-provider.js";
import { calculatePlayerPoints } from "../domain/scoring/engine.js";
import { LIVE_V1_RULESET } from "../domain/scoring/live-v1.js";
import { newId } from "../shared/ids.js";

const ui = readFileSync(resolve("app/src/main.ts"), "utf8");
const matchOpsUi = readFileSync(resolve("app/src/match-ops.ts"), "utf8");
const server = readFileSync(resolve("api/server.ts"), "utf8");

async function authed(deps: ReturnType<typeof buildTestApp>["deps"], grants: ReturnType<typeof buildTestApp>["grants"], role: "CEO_HEAD" | "BACKEND_DEVELOPER" | "SUPPORT" | "PRODUCT_MANAGER" | "UI_UX_DEVELOPER") {
  const wallet = generateWallet();
  const now = deps.clock();
  const issued = await deps.auth.issueNonce(wallet.publicKey, { now, correlationId: null });
  const login = await deps.auth.login(
    {
      walletAddress: wallet.publicKey,
      message: issued.message,
      signature: signMessage(issued.message, wallet.secretKey),
    },
    { now, correlationId: null },
  );
  grants.grantRole(login.account.id, role);
  return {
    headers: { authorization: `Bearer ${login.token}`, "content-type": "application/json" },
    accountId: login.account.id,
    wallet,
  };
}

function samplePlayers() {
  const positions = ["GK", "DEF", "DEF", "MID", "MID", "FWD"] as const;
  const players = [];
  for (const side of ["home", "away"] as const) {
    for (let i = 0; i < positions.length; i++) {
      players.push({
        displayName: `${side}-${positions[i]}-${i}`,
        shortName: `${side[0]}${positions[i]}${i}`,
        position: positions[i]!,
        clubSide: side,
        creditValue: 9,
        startingStatus: "STARTER" as const,
      });
    }
  }
  return players;
}

describe("Phase 18D.2 RBAC — MANAGE_MATCH_OPERATIONS", () => {
  it("is granted only to CEO_HEAD and BACKEND_DEVELOPER", () => {
    expect(PERMISSIONS).toContain("MANAGE_MATCH_OPERATIONS");
    expect(ROLE_PERMISSIONS.CEO_HEAD).toContain("MANAGE_MATCH_OPERATIONS");
    expect(ROLE_PERMISSIONS.BACKEND_DEVELOPER).toContain("MANAGE_MATCH_OPERATIONS");
    expect(ROLE_PERMISSIONS.PRODUCT_MANAGER).not.toContain("MANAGE_MATCH_OPERATIONS");
    expect(ROLE_PERMISSIONS.SUPPORT).not.toContain("MANAGE_MATCH_OPERATIONS");
    expect(ROLE_PERMISSIONS.UI_UX_DEVELOPER).not.toContain("MANAGE_MATCH_OPERATIONS");
    expect(ROLE_PERMISSIONS.APP_DEVELOPER).not.toContain("MANAGE_MATCH_OPERATIONS");
    expect(isAllowed({ roles: ["CEO_HEAD"], capabilities: [] }, "MANAGE_MATCH_OPERATIONS")).toBe(true);
    expect(isAllowed({ roles: ["SUPPORT"], capabilities: [] }, "MANAGE_MATCH_OPERATIONS")).toBe(false);
  });

  it("migration 019 seeds the permission", () => {
    const sql = readFileSync(resolve("migrations/019_phase18d2_match_operations.sql"), "utf8");
    expect(sql).toContain("MANAGE_MATCH_OPERATIONS");
    expect(sql).toContain("match_ops_credit_audits");
    expect(sql).toContain("match_ops_event_proposals");
    expect(sql).toContain("match_ops_mutation_audits");
  });
});

describe("Phase 18D.2 consumer isolation", () => {
  it("consumer UI never exposes Match Ops controls or /ops/matches nav", () => {
    expect(ui).not.toContain("/ops/matches");
    expect(ui).not.toContain("MANAGE_MATCH_OPERATIONS");
    expect(ui).not.toContain("Match Ops");
    expect(matchOpsUi).toContain("OPERATOR_MANAGED");
    expect(server).toContain('/ops/matches');
    expect(server).toContain("match-ops.html");
  });
});

describe("Phase 18D.2 HTTP authorization + flows", () => {
  it("rejects unauthorized and Support/Product; allows CEO create+credit+event+correction", async () => {
    resetMatchOpsServiceForTests();
    const now = new Date("2026-10-07T12:00:00.000Z");
    const { app, deps, grants, audit } = buildTestApp(() => now);
    const anon = await app.request("/v1/ops/match-ops/matches");
    expect(anon.status).toBe(401);

    const support = await authed(deps, grants, "SUPPORT");
    const denied = await app.request("/v1/ops/match-ops/matches", { headers: support.headers });
    expect(denied.status).toBe(403);

    const product = await authed(deps, grants, "PRODUCT_MANAGER");
    const deniedPm = await app.request("/v1/ops/match-ops/matches", { headers: product.headers });
    expect(deniedPm.status).toBe(403);

    const ceo = await authed(deps, grants, "CEO_HEAD");
    const created = await app.request("/v1/ops/match-ops/matches", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({
        competition: "Ops Cup",
        venue: "Ops Arena",
        kickoffAt: "2026-10-10T15:00:00.000Z",
        homeClub: { name: "Ops United", shortName: "OPS" },
        awayClub: { name: "Manual City", shortName: "MAN" },
        players: samplePlayers(),
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as {
      match: { id: string; homeClubId: string; awayClubId: string; dataSource: { provider: string; provenance?: string } };
      players: Array<{ id: string }>;
    };
    const matchId = createdBody.match.id;
    expect(createdBody.match.dataSource.provider).toBe(OPERATOR_PROVIDER_NAME);
    expect(createdBody.match.dataSource.provenance).toBe(OPERATOR_PROVENANCE);

    const playerId = createdBody.players[0]!.id;
    const frozenCreditsUsed = 99;
    const teamId = newId();
    const versionId = newId();
    await deps.footballStore!.createTeam({
      id: teamId,
      accountId: ceo.accountId,
      matchId,
      status: "LOCKED",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    await deps.footballStore!.insertVersion({
      id: versionId,
      teamId,
      version: 1,
      matchId,
      playerIds: createdBody.players.slice(0, 11).map((p) => p.id),
      captainId: playerId,
      viceId: createdBody.players[1]!.id,
      creditsUsed: frozenCreditsUsed,
      validationResult: { valid: true, errors: [] },
      createdAt: now.toISOString(),
    });

    const creditEdit = await app.request(`/v1/ops/match-ops/matches/${matchId}/credits`, {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({ playerId, creditValue: 14, reason: "form bump for future XI" }),
    });
    expect(creditEdit.status).toBe(200);
    const version = await deps.footballStore!.getVersionById(versionId);
    expect(version?.version.creditsUsed).toBe(frozenCreditsUsed);

    // Advance to LIVE for event entry
    for (const status of ["LOCKED", "LIVE"] as const) {
      const patch = await app.request(`/v1/ops/match-ops/matches/${matchId}`, {
        method: "PATCH",
        headers: ceo.headers,
        body: JSON.stringify({ status, reason: `to ${status}` }),
      });
      expect(patch.status).toBe(200);
    }

    const grokPropose = await app.request("/v1/ops/match-ops/proposals", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({
        matchId,
        eventType: "GOAL",
        primaryPlayerId: playerId,
        matchMinute: 37,
        note: "GOAL — Player X — 37'",
        source: "GROK_PROPOSED",
        providerEventId: `operator-test-goal-${matchId}`,
      }),
    });
    expect(grokPropose.status).toBe(201);
    const proposal = ((await grokPropose.json()) as { proposal: { id: string; status: string } }).proposal;
    expect(proposal.status).toBe("PROPOSED");

    // Grok proposal must NOT score before confirm
    let events = await deps.footballStore!.listEvents(matchId);
    expect(events).toHaveLength(0);

    const review = await app.request(`/v1/ops/match-ops/proposals/${proposal.id}/review`, {
      method: "POST",
      headers: ceo.headers,
      body: "{}",
    });
    expect(review.status).toBe(200);

    const confirm = await app.request(`/v1/ops/match-ops/proposals/${proposal.id}/confirm`, {
      method: "POST",
      headers: ceo.headers,
      body: "{}",
    });
    expect(confirm.status).toBe(200);
    const confirmed = (await confirm.json()) as {
      event: { eventId: string; metadata: { provenance: string } };
    };
    expect(confirmed.event.metadata.provenance).toBe("GROK_PROPOSED_MANUAL_CONFIRMED");
    events = await deps.footballStore!.listEvents(matchId);
    expect(events).toHaveLength(1);

    const dup = await app.request("/v1/ops/match-ops/proposals", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({
        matchId,
        eventType: "GOAL",
        primaryPlayerId: playerId,
        matchMinute: 37,
        source: "MANUAL_OPERATOR",
        providerEventId: `operator-test-goal-${matchId}`,
      }),
    });
    expect(dup.status).toBe(409);

    const scoringInputs = events.map((e) => ({
      eventId: e.eventId,
      eventType: e.eventType,
      primaryPlayerId: e.primaryPlayerId,
      secondaryPlayerId: e.secondaryPlayerId,
      supersedesEventId: e.supersedesEventId,
      sequence: e.sequence,
    }));
    const matchContext = {
      matchId,
      homeClubId: createdBody.match.homeClubId as string,
      awayClubId: createdBody.match.awayClubId as string,
    };
    const pointsBefore = calculatePlayerPoints(
      scoringInputs,
      playerId,
      LIVE_V1_RULESET,
      matchContext,
    );
    expect(pointsBefore).toBe(5000);

    const correction = await app.request(`/v1/ops/match-ops/matches/${matchId}/corrections`, {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({ originalEventId: confirmed.event.eventId, note: "VAR disallow" }),
    });
    expect(correction.status).toBe(200);
    events = await deps.footballStore!.listEvents(matchId);
    expect(events).toHaveLength(2);
    const scoringInputsAfter = events.map((e) => ({
      eventId: e.eventId,
      eventType: e.eventType,
      primaryPlayerId: e.primaryPlayerId,
      secondaryPlayerId: e.secondaryPlayerId,
      supersedesEventId: e.supersedesEventId,
      sequence: e.sequence,
    }));
    const pointsAfter = calculatePlayerPoints(
      scoringInputsAfter,
      playerId,
      LIVE_V1_RULESET,
      matchContext,
    );
    expect(pointsAfter).toBe(0);

    const auditRows = await audit.list(200);
    const related = auditRows.filter(
      (r) =>
        r.entityId === matchId ||
        (typeof r.metadata.matchId === "string" && r.metadata.matchId === matchId),
    );
    const actions = related.map((r) => r.action);
    expect(actions).toContain("MATCH_OPS_FIXTURE_CREATED");
    expect(actions).toContain("MATCH_OPS_CREDIT_EDITED");
    expect(actions).toContain("MATCH_OPS_EVENT_CONFIRMED");
    expect(actions).toContain("MATCH_OPS_CORRECTION_APPENDED");
  });

  it("refuses Sportmonks and Tutorial simulator via Match Ops writes", async () => {
    resetMatchOpsServiceForTests();
    const now = new Date("2026-10-07T12:00:00.000Z");
    const { app, deps, grants } = buildTestApp(() => now);
    const ceo = await authed(deps, grants, "CEO_HEAD");

    // Inject a sportmonks-looking match into the in-memory store
    await deps.footballStore!.upsertMatch!({
      id: "19722776-0000-4000-8000-000000000001",
      homeClubId: (await deps.footballStore!.listMatches())[0]!.homeClubId,
      awayClubId: (await deps.footballStore!.listMatches())[0]!.awayClubId,
      kickoffAt: now.toISOString(),
      competition: "Live League",
      venue: null,
      externalFixtureId: "19722776",
      status: "LIVE",
      lineupAvailable: true,
      dataSource: {
        provider: "sportmonks",
        label: "Sportmonks live",
        fetchedAt: now.toISOString(),
      },
    });

    const refused = await app.request("/v1/ops/match-ops/matches/19722776-0000-4000-8000-000000000001", {
      method: "PATCH",
      headers: ceo.headers,
      body: JSON.stringify({ status: "FULL_TIME", reason: "nope" }),
    });
    expect(refused.status).toBe(403);
    const body = (await refused.json()) as { error?: { message?: string } };
    expect(String(body.error?.message ?? "")).toMatch(/Sportmonks/i);

    const demo = buildDemoSingleMatchCatalog();
    await deps.footballStore!.upsertCatalog(demo);
    const tutorialId = demo.matches[0]!.id;
    const tutorialRefuse = await app.request(`/v1/ops/match-ops/matches/${tutorialId}`, {
      method: "PATCH",
      headers: ceo.headers,
      body: JSON.stringify({ competition: "hack", reason: "nope" }),
    });
    expect(tutorialRefuse.status).toBe(403);
  });

  it("BACKEND_DEVELOPER can open session; UI_UX cannot", async () => {
    const now = new Date("2026-10-07T12:00:00.000Z");
    const { app, deps, grants } = buildTestApp(() => now);
    const be = await authed(deps, grants, "BACKEND_DEVELOPER");
    const ok = await app.request("/v1/ops/match-ops/session", { headers: be.headers });
    expect(ok.status).toBe(200);
    const uiux = await authed(deps, grants, "UI_UX_DEVELOPER");
    const no = await app.request("/v1/ops/match-ops/session", { headers: uiux.headers });
    expect(no.status).toBe(403);
  });
});

describe("Phase 18D.2 service-level provenance", () => {
  it("marks fixtures OPERATOR_MANAGED and Grok proposals do not mutate scores until confirm", async () => {
    const store = new InMemoryFootballStore();
    const audit = new InMemoryAuditStore();
    const football = new FootballService(store, audit, { creditCap: 100, maxPlayersFromOneTeam: null });
    const live = new LiveScoringService(store, football, new InMemoryProviderIdMap(), new InMemoryRedis(), "test", audit, "operator");
    const service = createMatchOperationsService({
      footballStore: store,
      live,
      audit,
      clock: () => new Date("2026-10-07T12:00:00.000Z"),
    });
    const actor = {
      accountId: newId(),
      walletAddress: "OpsWallet1111111111111111111111111111111",
      role: "CEO_HEAD",
      requestId: "req-1",
    };
    const created = await service.createFixture(actor, {
      competition: "Unit Cup",
      kickoffAt: "2026-10-11T12:00:00.000Z",
      homeClub: { name: "Alpha", shortName: "ALP" },
      awayClub: { name: "Beta", shortName: "BET" },
      players: samplePlayers(),
    });
    expect(isOperatorManagedDataSource(created.match.dataSource)).toBe(true);
    expect(created.match.dataSource.provider).not.toBe(DEMO_PROVIDER_NAME);
    expect(created.match.dataSource.provider).not.toBe("sportmonks");

    const proposal = await service.proposeEvent(actor, {
      matchId: created.match.id,
      eventType: "SHOT_ON_TARGET",
      primaryPlayerId: created.players[0]!.id,
      matchMinute: 12,
      source: "GROK_PROPOSED",
    });
    expect(proposal.status).toBe("PROPOSED");
    expect(await store.listEvents(created.match.id)).toHaveLength(0);
  });
});
