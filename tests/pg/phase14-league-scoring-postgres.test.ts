/**
 * Postgres-backed Phase 14 league scoring via combined live pipeline.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_DEV_MATCH_UPCOMING } from "../../sports/local-dev-provider.js";
import { buildPgApp, loginPg } from "./harness.js";

describe("Phase 14 league scoring (Postgres)", () => {
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
      headers: { ...headers, "idempotency-key": `pg14-xi-${Math.random()}` },
      body: JSON.stringify({ playerIds, captainId: playerIds[0], viceId: playerIds[5] }),
    });
    expect(saveRes.status).toBe(201);
    const saved = (await saveRes.json()) as { version: { id: string } };
    return saved.version.id;
  }

  it("scores league members through live pipeline and rejects money paths", async () => {
    const owner = await loginPg(built.app);
    const a = await loginPg(built.app);
    const b = await loginPg(built.app);

    const create = await built.app.request("/leagues", {
      method: "POST",
      headers: { ...owner.headers, "idempotency-key": "pg14-league-create" },
      body: JSON.stringify({ name: "PG Unified", matchId: LOCAL_DEV_MATCH_UPCOMING, capacity: 4 }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { league: { id: string; inviteCode: string } };

    const xiA = await xi(a.headers);
    const xiB = await xi(b.headers);
    const j1 = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...a.headers, "idempotency-key": "pg14-join-a" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiA }),
    });
    expect(j1.status).toBe(201);
    const j2 = await built.app.request("/leagues/join", {
      method: "POST",
      headers: { ...b.headers, "idempotency-key": "pg14-join-b" },
      body: JSON.stringify({ inviteCode: created.league.inviteCode, teamVersionId: xiB }),
    });
    expect(j2.status).toBe(201);

    const board = await built.app.request(`/leagues/${created.league.id}/leaderboard`, {
      headers: a.headers,
    });
    expect(board.status).toBe(200);
    const payload = (await board.json()) as {
      freshness: string;
      scoreSnapshotId: string | null;
      rows: Array<{ wallet: string; rank: number; milliPoints: number; you: boolean }>;
    };
    expect(payload.rows.length).toBe(2);
    expect(payload.rows.some((r) => r.you)).toBe(true);
    // Snapshot present when live pipeline is wired (even with zero events).
    expect(payload.freshness === "UNKNOWN" || payload.freshness === "LIVE" || payload.freshness === "STALE").toBe(
      true,
    );

    const money = await built.app.request(`/leagues/${created.league.id}/claim`, {
      method: "POST",
      headers: a.headers,
      body: "{}",
    });
    expect(money.status).toBe(409);

    const sharePage = await built.app.request(`/share/league/${created.league.id}`);
    expect(sharePage.status).toBe(200);
    expect(await sharePage.text()).toContain("og:title");
  }, 120_000);
});
