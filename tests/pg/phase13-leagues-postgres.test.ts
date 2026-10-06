/**
 * Postgres-backed Phase 13 private league isolation / joins.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_DEV_MATCH_UPCOMING } from "../../sports/local-dev-provider.js";
import { buildPgApp, loginPg } from "./harness.js";

describe("Phase 13 private leagues (Postgres)", () => {
  let built: Awaited<ReturnType<typeof buildPgApp>>;

  beforeAll(async () => {
    built = await buildPgApp();
  }, 120_000);

  afterAll(async () => {
    await built.close();
  });

  async function xi(headers: Record<string, string>) {
    const poolRes = await built.app.request(`/matches/${LOCAL_DEV_MATCH_UPCOMING}/players`, { headers });
    expect(poolRes.status).toBe(200);
    const pool = (await poolRes.json()) as {
      players: Array<{ playerId: string; position: string; clubId: string }>;
    };
    const home = pool.players[0]?.clubId ?? "";
    const away = pool.players.find((p) => p.clubId !== home)?.clubId ?? "";
    const pick = (pos: string, clubId: string, nth: number) =>
      pool.players.filter((p) => p.position === pos && p.clubId === clubId)[nth]!.playerId;
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
    const teamRes = await built.app.request("/teams", {
      method: "POST",
      headers,
      body: JSON.stringify({ matchId: LOCAL_DEV_MATCH_UPCOMING }),
    });
    expect(teamRes.status).toBe(201);
    const team = (await teamRes.json()) as { team: { id: string } };
    const saveRes = await built.app.request(`/teams/${team.team.id}/versions`, {
      method: "POST",
      headers: { ...headers, "idempotency-key": `pg-xi-${Math.random()}` },
      body: JSON.stringify({ playerIds, captainId: playerIds[0], viceId: playerIds[5] }),
    });
    expect(saveRes.status).toBe(201);
    const saved = (await saveRes.json()) as { version: { id: string } };
    return saved.version.id;
  }

  it("creates, joins, rejects duplicate/invalid/full, and blocks money paths", async () => {
    const owner = await loginPg(built.app);
    const a = await loginPg(built.app);
    const b = await loginPg(built.app);
    const c = await loginPg(built.app);

    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": "pg-league-create1" },
      body: JSON.stringify({ name: "PG Friday", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 2 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { league: { id: string; inviteCode: string } };

    const bad = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...a.headers, "idempotency-key": "pg-bad-invite-01" },
      body: JSON.stringify({ inviteCode: "NOPECODE", teamVersionId: await xi(a.headers) }),
    });
    expect(bad.status).toBe(404);

    const xiA = await xi(a.headers);
    const j1 = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...a.headers, "idempotency-key": "pg-join-slot-001" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiA }),
    });
    expect(j1.status).toBe(201);

    const dup = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...a.headers, "idempotency-key": "pg-dup-join-001" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiA }),
    });
    expect(dup.status).toBe(409);

    const j2 = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...b.headers, "idempotency-key": "pg-join-slot-002" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: await xi(b.headers) }),
    });
    expect(j2.status).toBe(201);

    const full = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...c.headers, "idempotency-key": "pg-full-join-001" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: await xi(c.headers) }),
    });
    expect(full.status).toBe(409);

    const money = await built.app.request(`/leagues/${created.league.id}/settlement`, {
      method: "POST",
      headers: owner.headers,
      body: "{}",
    });
    expect(money.status).toBe(409);

    const profile = await built.app.request("/v1/me/profile", {
      method: "PATCH",
      headers: { ...owner.headers, "idempotency-key": "pg-profile-name1" },
      body: JSON.stringify({ displayName: "Owner One" }),
    });
    expect(profile.status).toBe(200);
  }, 120_000);
});
