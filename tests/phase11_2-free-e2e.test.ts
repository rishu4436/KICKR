/**
 * Phase 11.2: clean FREE E2E harness gate, scoring actor, saved XI reload.
 */
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import {
  assertFreeDevHarnessAllowed,
  isFreeDevHarnessAllowed,
} from "../contests/free/dev-gate.js";
import { LocalDevScoringActorRegistry } from "../contests/free/local-dev-scoring-actor.js";
import { ROLE_PERMISSIONS } from "../rbac/matrix.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";
import { AppError } from "../shared/errors.js";
import { LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";

const NOW = new Date("2026-10-06T12:00:00.000Z");

describe("Phase 11.2 FREE E2E harness + player polish", () => {
  it("blocks the harness in production and non-local-dev", () => {
    expect(
      isFreeDevHarnessAllowed({ nodeEnv: "production", sportsDataProvider: "local-dev" }),
    ).toBe(false);
    expect(
      isFreeDevHarnessAllowed({ nodeEnv: "development", sportsDataProvider: "sportmonks" }),
    ).toBe(false);
    expect(
      isFreeDevHarnessAllowed({ nodeEnv: "development", sportsDataProvider: "local-dev" }),
    ).toBe(true);
    expect(() =>
      assertFreeDevHarnessAllowed({ nodeEnv: "production", sportsDataProvider: "local-dev" }),
    ).toThrow(AppError);
  });

  it("refuses gated E2E routes when NODE_ENV=production", async () => {
    const built = buildTestApp(() => NOW);
    built.deps.config.server.nodeEnv = "production";
    built.deps.config.public.environment = "production";
    built.deps.config.public.sportsDataProvider = "local-dev";
    const wallet = generateWallet();
    const nonce = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session = await built.deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: nonce.message,
        signature: signMessage(nonce.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    const res = await built.app.request("/v1/dev/e2e/matches", {
      method: "POST",
      headers: {
        authorization: `Bearer ${session.token}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("DEV_HARNESS_BLOCKED");
  });

  it("registers a LOCAL_DEV scoring actor that cannot exist as a matrix grant", async () => {
    const audit = new InMemoryAuditStore();
    const registry = new LocalDevScoringActorRegistry(
      { nodeEnv: "development", sportsDataProvider: "local-dev" },
      audit,
    );
    await registry.register("11111111-1111-4111-8111-111111111111", { now: NOW, correlationId: null });
    expect(registry.isActor("11111111-1111-4111-8111-111111111111")).toBe(true);
    expect(ROLE_PERMISSIONS.BACKEND_DEVELOPER).toContain("RUN_SCORING");
    // RUN_SETTLEMENT remains nobody
    const granted = new Set(Object.values(ROLE_PERMISSIONS).flat());
    expect(granted.has("RUN_SETTLEMENT")).toBe(false);

    const prod = new LocalDevScoringActorRegistry(
      { nodeEnv: "production", sportsDataProvider: "local-dev" },
      audit,
    );
    await expect(prod.register("22222222-2222-4222-8222-222222222222", { now: NOW, correlationId: null })).rejects.toBeInstanceOf(
      AppError,
    );
    expect(prod.isActor("22222222-2222-4222-8222-222222222222")).toBe(false);
  });

  it("reloads the latest saved XI for a match and versions immutably", async () => {
    const built = buildTestApp(() => NOW);
    const wallet = generateWallet();
    const nonce = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
    const session = await built.deps.auth.login(
      {
        walletAddress: wallet.publicKey,
        message: nonce.message,
        signature: signMessage(nonce.message, wallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    const headers = {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    };
    const empty = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/my-team`, { headers });
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { team: null }).team).toBeNull();

    const poolRes = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/players`, { headers });
    const pool = (await poolRes.json()) as {
      players: Array<{ playerId: string; position: string; clubId: string }>;
    };
    const players = pool.players;
    const home = players[0]!.clubId;
    const away = players.find((p) => p.clubId !== home)!.clubId;
    const take = (pos: string, clubId: string, nth: number) =>
      players.filter((p) => p.position === pos && p.clubId === clubId)[nth]!.playerId;
    const playerIds = [
      take("GK", home, 0),
      take("DEF", home, 0),
      take("DEF", home, 1),
      take("DEF", home, 2),
      take("DEF", home, 3),
      take("MID", home, 0),
      take("MID", home, 1),
      take("MID", away, 0),
      take("DEF", away, 0),
      take("FWD", away, 1),
      take("MID", away, 1),
    ];
    const captainId = playerIds[5]!;
    const viceId = playerIds[6]!;
    const teamRes = await built.app.request("/teams", {
      method: "POST",
      headers,
      body: JSON.stringify({ matchId: LOCAL_DEV_MATCH_UPCOMING }),
    });
    const teamBody = (await teamRes.json()) as { team: { id: string } };
    const v1 = await built.app.request(`/teams/${teamBody.team.id}/versions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ playerIds, captainId, viceId }),
    });
    expect(v1.status).toBe(201);
    const v1Body = (await v1.json()) as { version: { id: string; version: number } };
    expect(v1Body.version.version).toBe(1);

    const loaded = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/my-team`, { headers });
    const loadedBody = (await loaded.json()) as {
      team: { id: string };
      latest: { id: string; captainId: string; viceId: string; playerIds: string[] };
      readOnly: boolean;
    };
    expect(loadedBody.team.id).toBe(teamBody.team.id);
    expect(loadedBody.latest.id).toBe(v1Body.version.id);
    expect(loadedBody.latest.captainId).toBe(captainId);
    expect(loadedBody.latest.viceId).toBe(viceId);
    expect(loadedBody.latest.playerIds).toEqual(playerIds);
    expect(loadedBody.readOnly).toBe(false);

    // Editing creates the next immutable version on the same team.
    const team2 = await built.app.request("/teams", {
      method: "POST",
      headers,
      body: JSON.stringify({ matchId: LOCAL_DEV_MATCH_UPCOMING }),
    });
    const team2Body = (await team2.json()) as { team: { id: string } };
    expect(team2Body.team.id).toBe(teamBody.team.id);
    const newCaptain = playerIds[6]!;
    const newVice = playerIds[5]!;
    const v2 = await built.app.request(`/teams/${team2Body.team.id}/versions`, {
      method: "POST",
      headers,
      body: JSON.stringify({ playerIds, captainId: newCaptain, viceId: newVice }),
    });
    expect(v2.status).toBe(201);
    const v2Body = (await v2.json()) as { version: { id: string; version: number; captainId: string } };
    expect(v2Body.version.version).toBe(2);
    expect(v2Body.version.id).not.toBe(v1Body.version.id);

    const loaded2 = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/my-team`, { headers });
    const loaded2Body = (await loaded2.json()) as { latest: { id: string; captainId: string; version: number } };
    expect(loaded2Body.latest.id).toBe(v2Body.version.id);
    expect(loaded2Body.latest.captainId).toBe(newCaptain);
    expect(loaded2Body.latest.version).toBe(2);
  });
});
