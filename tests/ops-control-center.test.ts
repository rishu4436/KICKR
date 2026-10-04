import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deleteAuditEvent, updateAuditEvent } from "../audit/guard.js";
import { isAllowed } from "../rbac/authorize.js";
import { ROLES, type RoleCode } from "../rbac/matrix.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";
import { LOCAL_DEV_MATCH_UPCOMING } from "../sports/local-dev-provider.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");

async function login(
  role: RoleCode | "REVIEWER" | null,
): Promise<{
  app: ReturnType<typeof buildTestApp>["app"];
  deps: ReturnType<typeof buildTestApp>["deps"];
  grants: ReturnType<typeof buildTestApp>["grants"];
  audit: ReturnType<typeof buildTestApp>["audit"];
  token: string;
  accountId: string;
  wallet: string;
  headers: Record<string, string>;
}> {
  const built = buildTestApp(() => NOW);
  const wallet = generateWallet();
  const issued = await built.deps.auth.issueNonce(wallet.publicKey, { now: NOW, correlationId: null });
  const session = await built.deps.auth.login(
    {
      walletAddress: wallet.publicKey,
      message: issued.message,
      signature: signMessage(issued.message, wallet.secretKey),
    },
    { now: NOW, correlationId: null },
  );
  if (role === "REVIEWER") {
    await built.grants.grantCapability(session.account.id, "REVIEWER");
  } else if (role) {
    await built.grants.grantRole(session.account.id, role);
  }
  return {
    ...built,
    token: session.token,
    accountId: session.account.id,
    wallet: wallet.publicKey,
    headers: {
      authorization: `Bearer ${session.token}`,
      "content-type": "application/json",
    },
  };
}

describe("operations control center", () => {
  it("rejects an unauthenticated control center request", async () => {
    const { app } = buildTestApp(() => NOW);
    const response = await app.request("/v1/ops/overview");
    expect(response.status).toBe(401);
    const session = await app.request("/v1/ops/session");
    expect(session.status).toBe(401);
  });

  it("rejects an authenticated account with no authorized role", async () => {
    const { app, headers } = await login(null);
    const response = await app.request("/v1/ops/overview", { headers });
    expect(response.status).toBe(403);
    const session = await app.request("/v1/ops/session", { headers });
    expect(session.status).toBe(403);
  });

  it("allows an authorized read and rejects an unauthorized action", async () => {
    const reader = await login("UI_UX_DEVELOPER");
    const overview = await reader.app.request("/v1/ops/overview", { headers: reader.headers });
    expect(overview.status).toBe(200);
    const body = await overview.json() as { health: string; runSettlement: string };
    expect(body.runSettlement).toBe("not_granted");
    expect(["ok", "degraded", "unknown"]).toContain(body.health);

    const support = await login("SUPPORT");
    const entries = await support.app.request("/v1/ops/entries", { headers: support.headers });
    expect(entries.status).toBe(200);
    const calculate = await support.app.request("/v1/ops/contests/00000000-0000-4000-8000-000000000099/settlement/calculate", {
      method: "POST",
      headers: support.headers,
      body: JSON.stringify({ confirm: true, confirmationText: "CALCULATE_RESULT" }),
    });
    expect(calculate.status).toBe(403);
    const audit = await support.app.request("/v1/ops/audit/events", { headers: support.headers });
    expect(audit.status).toBe(403);
  });

  it("keeps reviewer and scoring boundaries distinct", async () => {
    const reviewer = await login("REVIEWER");
    const backend = await login("BACKEND_DEVELOPER");
    const missing = "00000000-0000-4000-8000-000000000099";
    const review = await reviewer.app.request(`/v1/ops/settlements/${missing}/review`, {
      method: "POST",
      headers: reviewer.headers,
      body: JSON.stringify({ confirm: true, confirmationText: "REVIEW_RESULT" }),
    });
    expect(review.status).not.toBe(403);
    const reviewerScore = await reviewer.app.request(`/v1/ops/contests/${missing}/settlement/calculate`, {
      method: "POST",
      headers: reviewer.headers,
      body: JSON.stringify({ confirm: true, confirmationText: "CALCULATE_RESULT" }),
    });
    expect(reviewerScore.status).toBe(403);
    const score = await backend.app.request(`/v1/ops/contests/${missing}/settlement/calculate`, {
      method: "POST",
      headers: backend.headers,
      body: JSON.stringify({ confirm: true, confirmationText: "CALCULATE_RESULT" }),
    });
    expect(score.status).not.toBe(403);
    const backendReview = await backend.app.request(`/v1/ops/settlements/${missing}/review`, {
      method: "POST",
      headers: backend.headers,
      body: JSON.stringify({ confirm: true, confirmationText: "REVIEW_RESULT" }),
    });
    expect(backendReview.status).toBe(403);

    const settlementId = "00000000-0000-4000-8000-000000000088";
    await reviewer.audit.append({
      action: "RESULT_CALCULATED",
      occurredAt: NOW,
      entityType: "SETTLEMENT",
      entityId: settlementId,
      metadata: { result: "calculated" },
      actorAccountId: reviewer.accountId,
      actorWallet: reviewer.wallet,
      correlationId: null,
    });
    const self = await reviewer.app.request(`/settlements/${settlementId}/approve`, {
      method: "POST",
      headers: reviewer.headers,
    });
    expect(self.status).toBe(403);
    const selfBody = await self.json() as { error: { code: string } };
    expect(selfBody.error.code).toBe("SELF_APPROVAL");
  });

  it("does not grant RUN_SETTLEMENT and blocks direct fund movement", async () => {
    for (const role of ROLES) {
      expect(isAllowed({ roles: [role], capabilities: [] }, "RUN_SETTLEMENT")).toBe(false);
    }
    expect(isAllowed({ roles: [], capabilities: ["REVIEWER"] }, "RUN_SETTLEMENT")).toBe(false);
    const ceo = await login("CEO_HEAD");
    const permissions = await ceo.app.request("/v1/me/permissions", { headers: ceo.headers });
    const listed = await permissions.json() as { permissions: string[] };
    expect(listed.permissions).not.toContain("RUN_SETTLEMENT");
    const prepare = await ceo.app.request("/settlements/00000000-0000-4000-8000-000000000099/prepare", {
      method: "POST",
      headers: ceo.headers,
      body: "{}",
    });
    expect(prepare.status).toBe(403);
    const run = await ceo.app.request("/v1/ops/settlements/00000000-0000-4000-8000-000000000099/run", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({ confirm: true }),
    });
    expect(run.status).toBe(403);
    const withdraw = await ceo.app.request("/v1/ops/treasury/withdraw", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({ amount: 1, destination: ceo.wallet }),
    });
    expect(withdraw.status).toBe(403);
    const withdrawBody = await withdraw.json() as { error: { code: string } };
    expect(withdrawBody.error.code).toBe("FUNDS_MOVEMENT_DENIED");
    const sweep = await ceo.app.request("/v1/ops/vault/sweep", {
      method: "POST",
      headers: ceo.headers,
      body: "{}",
    });
    expect(sweep.status).toBe(403);
  });

  it("does not let a direct API call bypass the same authorization", async () => {
    const { app, headers } = await login(null);
    const response = await app.request("/v1/ops/audit/events", { headers });
    expect(response.status).toBe(403);
  });

  it("does not return an entry when the contest id is changed", async () => {
    const ceo = await login("CEO_HEAD");
    const players = await ceo.deps.football.getPlayerPool(LOCAL_DEV_MATCH_UPCOMING);
    if (!players) throw new Error("missing pool");
    const home = players[0]?.clubId ?? "";
    const away = players.find((player) => player.clubId !== home)?.clubId ?? "";
    const pick = (position: string, clubId: string, nth: number) => {
      const found = players.filter((player) => player.position === position && player.clubId === clubId);
      const player = found[nth];
      if (!player) throw new Error(`missing ${position}`);
      return player.playerId;
    };
    const playerIds = [
      pick("GK", home, 0), pick("DEF", home, 0), pick("DEF", home, 1), pick("DEF", home, 2), pick("DEF", home, 3),
      pick("MID", home, 0), pick("MID", home, 1), pick("MID", away, 0), pick("DEF", away, 0), pick("FWD", away, 1), pick("MID", away, 1),
    ];
    const team = await ceo.deps.football.createTeam(ceo.accountId, LOCAL_DEV_MATCH_UPCOMING, { now: NOW, correlationId: null });
    const version = await ceo.deps.football.saveVersion(team.id, ceo.accountId, {
      playerIds,
      captainId: playerIds[0] ?? "",
      viceId: playerIds[5] ?? "",
    }, { now: NOW, correlationId: null });
    const rooms = await ceo.deps.contests.listMatchContests(LOCAL_DEV_MATCH_UPCOMING, ceo.wallet, { now: NOW, correlationId: null });
    const contest = rooms[0];
    const other = rooms[1];
    if (!contest || !other) throw new Error("missing contests");
    const reserved = await ceo.deps.contests.reserve(contest.contestId, ceo.accountId, ceo.wallet, version.id, { now: NOW, correlationId: null });
    const wrong = await ceo.app.request(`/v1/ops/entries/${reserved.entry.id}?contestId=${other.contestId}`, { headers: ceo.headers });
    expect(wrong.status).toBe(404);
    const wrongBody = await wrong.text();
    expect(wrongBody).not.toContain(ceo.wallet);
    const right = await ceo.app.request(`/v1/ops/entries/${reserved.entry.id}?contestId=${contest.contestId}`, { headers: ceo.headers });
    expect(right.status).toBe(200);
  });

  it("rejects a revoked session", async () => {
    const ceo = await login("CEO_HEAD");
    await ceo.deps.auth.logout(ceo.token, { now: NOW, correlationId: null });
    const response = await ceo.app.request("/v1/ops/overview", { headers: ceo.headers });
    expect(response.status).toBe(401);
  });

  it("writes audit events for access changes and refuses self grant and settlement authority", async () => {
    const ceo = await login("CEO_HEAD");
    const otherWallet = generateWallet();
    const issued = await ceo.deps.auth.issueNonce(otherWallet.publicKey, { now: NOW, correlationId: null });
    const other = await ceo.deps.auth.login(
      {
        walletAddress: otherWallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, otherWallet.secretKey),
      },
      { now: NOW, correlationId: null },
    );
    const granted = await ceo.app.request("/v1/ops/access/roles", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({
        confirm: true,
        confirmationText: "GRANT_ROLE",
        accountId: other.account.id,
        role: "APP_DEVELOPER",
      }),
    });
    expect(granted.status).toBe(201);
    const events = await ceo.audit.query({ limit: 20, action: "ROLE_GRANTED" });
    expect(events.some((event) => event.entityId === other.account.id)).toBe(true);
    const self = await ceo.app.request("/v1/ops/access/roles", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({
        confirm: true,
        confirmationText: "GRANT_ROLE",
        accountId: ceo.accountId,
        role: "BACKEND_DEVELOPER",
      }),
    });
    expect(self.status).toBe(403);
    const settlement = await ceo.app.request("/v1/ops/access/roles", {
      method: "POST",
      headers: ceo.headers,
      body: JSON.stringify({
        confirm: true,
        confirmationText: "GRANT_ROLE",
        accountId: other.account.id,
        role: "RUN_SETTLEMENT",
      }),
    });
    expect(settlement.status).toBe(403);
    expect(isAllowed({ roles: ["APP_DEVELOPER"], capabilities: [] }, "RUN_SETTLEMENT")).toBe(false);
  });

  it("rejects audit modification and deletion", async () => {
    expect(() => updateAuditEvent()).toThrow(/UPDATE/);
    expect(() => deleteAuditEvent()).toThrow(/DELETE/);
    const ceo = await login("CEO_HEAD");
    const patch = await ceo.app.request("/v1/ops/audit/events/00000000-0000-4000-8000-000000000001", {
      method: "PATCH",
      headers: ceo.headers,
      body: JSON.stringify({ action: "ACCOUNT_LOGIN" }),
    });
    const del = await ceo.app.request("/v1/ops/audit/events/00000000-0000-4000-8000-000000000001", {
      method: "DELETE",
      headers: ceo.headers,
    });
    expect(patch.status).toBe(405);
    expect(del.status).toBe(405);
  });

  it("rejects a wallet that does not match the session", async () => {
    const ceo = await login("CEO_HEAD");
    const response = await ceo.app.request("/v1/ops/overview", {
      headers: { ...ceo.headers, "x-wallet-address": "not-the-session-wallet" },
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe("WALLET_MISMATCH");
  });

  it("keeps claim proofs owner-scoped from staff", async () => {
    const ceo = await login("CEO_HEAD");
    const response = await ceo.app.request("/v1/ops/claims/00000000-0000-4000-8000-000000000077/proof?contestId=00000000-0000-4000-8000-000000000066", {
      headers: ceo.headers,
    });
    expect(response.status).toBe(403);
    const text = await response.text();
    expect(text).not.toContain("\"proof\":");
    expect(text).toContain("owner-scoped");
  });

  it("does not hardcode role names into the control center UI", () => {
    const ui = readFileSync(path.resolve(process.cwd(), "app/src/ops.ts"), "utf8");
    for (const role of ROLES) {
      expect(ui).not.toContain(role);
    }
    expect(ui).not.toContain("sessionStorage");
    expect(ui).not.toContain("localStorage");
    expect(ui).not.toContain("innerHTML");
    expect(ui).not.toContain("RUN_SETTLEMENT");
  });
});
