import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { updateFantasyTeamVersion, updateMatchEvent } from "../football/store.js";
import { LOCAL_DEV_MATCH_LIVE, LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";

async function login(app: ReturnType<typeof buildTestApp>["app"], wallet = generateWallet()) {
  const nonce = await app.request("/v1/auth/nonce", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ walletAddress: wallet.publicKey }),
  });
  const issued = (await nonce.json()) as { message: string };
  const response = await app.request("/v1/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      walletAddress: wallet.publicKey,
      message: issued.message,
      signature: signMessage(issued.message, wallet.secretKey),
    }),
  });
  const body = (await response.json()) as { token: string; account: { id: string } };
  return { token: body.token, accountId: body.account.id, wallet };
}

describe("football API", () => {
  it("requires auth and lists development matches without contest entry", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const { app } = buildTestApp(() => now);
    const anonymous = await app.request("/matches");
    expect(anonymous.status).toBe(401);
    const session = await login(app);
    const response = await app.request("/matches", {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      creditCap: number;
      maxPlayersFromOneTeam: number | null;
      matches: Array<{ id: string; canBuildXi: boolean; bucket: string; dataSource: { label: string } }>;
    };
    expect(body.creditCap).toBe(100);
    expect(body.maxPlayersFromOneTeam).toBeNull();
    expect(body.matches.every((match) => match.dataSource.label.includes("not a live feed"))).toBe(true);
    const upcoming = body.matches.find((match) => match.id === LOCAL_DEV_MATCH_UPCOMING);
    const live = body.matches.find((match) => match.id === LOCAL_DEV_MATCH_LIVE);
    expect(upcoming?.canBuildXi).toBe(true);
    expect(upcoming?.bucket).toBe("upcoming");
    expect(live?.canBuildXi).toBe(false);
    expect(JSON.stringify(body)).not.toMatch(/usdc|winnings|escrow/i);
  });

  it("saves a new version, writes TEAM_SAVED, and rejects a locked team", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const built = buildTestApp(() => now);
    const session = await login(built.app);
    const playersResponse = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/players`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const playersBody = (await playersResponse.json()) as {
      players: Array<{ playerId: string; position: string; clubId: string; credit: number }>;
    };
    const pick = (position: string, clubId: string, nth: number) => {
      const found = playersBody.players.filter((player) => player.position === position && player.clubId === clubId);
      const player = found[nth];
      if (!player) {
        throw new Error(`missing ${position}`);
      }
      return player.playerId;
    };
    const home = playersBody.players[0]?.clubId ?? "";
    const away = playersBody.players.find((player) => player.clubId !== home)?.clubId ?? "";
    const playerIds = [
      pick("GK", home, 0),
      pick("DEF", home, 0),
      pick("DEF", home, 1),
      pick("DEF", home, 2),
      pick("DEF", home, 3),
      pick("MID", home, 0),
      pick("MID", home, 1),
      pick("MID", away, 0),
      pick("DEF", away, 0),
      pick("FWD", away, 1),
      pick("MID", away, 1),
    ];
    const created = await built.app.request("/teams", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ matchId: LOCAL_DEV_MATCH_UPCOMING }),
    });
    expect(created.status).toBe(201);
    const team = (await created.json()) as { team: { id: string; status: string } };
    expect(team.team.status).toBe("DRAFT");

    const bad = await built.app.request(`/teams/${team.team.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ playerIds: playerIds.slice(0, 10), captainId: playerIds[0], viceId: playerIds[5] }),
    });
    expect(bad.status).toBe(400);
    const badBody = (await bad.json()) as { error: { details: { errors: Array<{ code: string }> } } };
    expect(badBody.error.details.errors.map((error) => error.code)).toContain("NOT_EXACTLY_11");

    const saved = await built.app.request(`/teams/${team.team.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json", "x-request-id": "team-save-1" },
      body: JSON.stringify({ playerIds, captainId: playerIds[0], viceId: playerIds[5] }),
    });
    expect(saved.status).toBe(201);
    const version = (await saved.json()) as { version: { version: number; creditsUsed: number } };
    expect(version.version.version).toBe(1);
    expect(version.version.creditsUsed).toBe(99);

    const again = await built.app.request(`/teams/${team.team.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ playerIds, captainId: playerIds[1], viceId: playerIds[6] }),
    });
    expect(again.status).toBe(201);
    const history = await built.app.request(`/teams/${team.team.id}/versions`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    const historyBody = (await history.json()) as { versions: Array<{ version: number }> };
    expect(historyBody.versions.map((row) => row.version)).toEqual([1, 2]);

    const events = await built.audit.list(20);
    const savedEvents = events.filter((event) => event.action === "TEAM_SAVED");
    expect(savedEvents).toHaveLength(2);
    expect(savedEvents[0]?.correlationId).toBe("team-save-1");
    expect(savedEvents[0]?.metadata).toMatchObject({ version: 1, matchId: LOCAL_DEV_MATCH_UPCOMING });

    const other = await login(built.app);
    const hidden = await built.app.request(`/teams/${team.team.id}`, {
      headers: { authorization: `Bearer ${other.token}` },
    });
    expect(hidden.status).toBe(404);

    await built.deps.football.lockTeam(team.team.id, session.accountId, {
      now,
      correlationId: null,
    });
    const locked = await built.app.request(`/teams/${team.team.id}/versions`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ playerIds, captainId: playerIds[0], viceId: playerIds[5] }),
    });
    expect(locked.status).toBe(409);
    const lockedBody = (await locked.json()) as { error: { code: string } };
    expect(lockedBody.error.code).toBe("TEAM_LOCKED");

    const live = await built.app.request("/teams", {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({ matchId: LOCAL_DEV_MATCH_LIVE }),
    });
    expect(live.status).toBe(409);
  });

  it("keeps version and event history append-only in the migration", () => {
    const sql = readFileSync(path.resolve("migrations/002_phase2_football_domain.sql"), "utf8");
    expect(sql).toContain("fantasy_team_versions is append-only");
    expect(sql).toContain("match_events is append-only");
    expect(sql).toContain("BEFORE UPDATE ON fantasy_team_versions");
    expect(sql).toContain("BEFORE DELETE ON match_events");
    expect(() => updateFantasyTeamVersion()).toThrow(/append-only/);
    expect(() => updateMatchEvent()).toThrow(/append-only/);
    const phase1 = readFileSync(path.resolve("migrations/001_phase1_identity_rbac_audit.sql"), "utf8");
    expect(phase1).not.toContain("fantasy_teams");
  });
});
