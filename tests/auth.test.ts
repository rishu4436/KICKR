import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "../audit/memory.js";
import {
  InMemoryAccountRepository,
  InMemoryNonceRepository,
  InMemorySessionRepository,
} from "../auth/memory.js";
import { AuthService } from "../auth/service.js";
import { AppError } from "../shared/errors.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";

function service(ttl = { nonce: 300, session: 3600 }): {
  auth: AuthService;
  audit: InMemoryAuditStore;
} {
  const audit = new InMemoryAuditStore();
  const auth = new AuthService(
    new InMemoryAccountRepository(),
    new InMemoryNonceRepository(),
    new InMemorySessionRepository(),
    audit,
    { domain: "localhost", nonceTtlSeconds: ttl.nonce, sessionTtlSeconds: ttl.session },
  );
  return { auth, audit };
}

async function issueAndSign(
  auth: AuthService,
  wallet: { publicKey: string; secretKey: Uint8Array },
  now: Date,
): Promise<{ message: string; signature: string; nonce: string }> {
  const issued = await auth.issueNonce(wallet.publicKey, { now, correlationId: "corr-login" });
  return {
    message: issued.message,
    signature: signMessage(issued.message, wallet.secretKey),
    nonce: issued.nonce,
  };
}

describe("wallet login", () => {
  it("accepts a valid signature and writes ACCOUNT_LOGIN", async () => {
    const { auth, audit } = service();
    const wallet = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const session = await auth.login(
      { walletAddress: wallet.publicKey, message: signed.message, signature: signed.signature },
      { now, correlationId: "corr-login" },
    );
    expect(session.tokenType).toBe("Bearer");
    expect(session.account.walletAddress).toBe(wallet.publicKey);
    const events = await audit.list(10);
    expect(events).toHaveLength(1);
    expect(events[0]?.action).toBe("ACCOUNT_LOGIN");
    expect(events[0]?.actorWallet).toBe(wallet.publicKey);
    expect(events[0]?.metadata).toMatchObject({ method: "solana_wallet", domain: "localhost" });
    expect(events[0]?.correlationId).toBe("corr-login");
    const principal = await auth.authenticate(session.token, { now, correlationId: null });
    expect(principal.accountId).toBe(session.account.id);
  });

  it("rejects an invalid signature", async () => {
    const { auth } = service();
    const wallet = generateWallet();
    const other = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const bad = signMessage(signed.message, other.secretKey);
    await expect(
      auth.login(
        { walletAddress: wallet.publicKey, message: signed.message, signature: bad },
        { now, correlationId: null },
      ),
    ).rejects.toMatchObject({ code: "AUTH_INVALID_SIGNATURE" });
  });

  it("rejects an expired nonce", async () => {
    const { auth } = service();
    const wallet = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const later = new Date(now.getTime() + 301_000);
    await expect(
      auth.login(
        { walletAddress: wallet.publicKey, message: signed.message, signature: signed.signature },
        { now: later, correlationId: null },
      ),
    ).rejects.toMatchObject({ code: "AUTH_NONCE_EXPIRED" });
  });

  it("rejects a reused nonce", async () => {
    const { auth } = service();
    const wallet = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const input = {
      walletAddress: wallet.publicKey,
      message: signed.message,
      signature: signed.signature,
    };
    await auth.login(input, { now, correlationId: null });
    await expect(auth.login(input, { now, correlationId: null })).rejects.toMatchObject({
      code: "AUTH_NONCE_REUSED",
    });
  });

  it("rejects a wrong domain and does not consume the nonce", async () => {
    const { auth } = service();
    const wallet = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const tampered = signed.message.replace("Domain: localhost", "Domain: evil.example");
    const signature = signMessage(tampered, wallet.secretKey);
    await expect(
      auth.login(
        { walletAddress: wallet.publicKey, message: tampered, signature },
        { now, correlationId: null },
      ),
    ).rejects.toMatchObject({ code: "AUTH_DOMAIN_MISMATCH" });
    const retry = await auth.login(
      { walletAddress: wallet.publicKey, message: signed.message, signature: signed.signature },
      { now, correlationId: null },
    );
    expect(retry.account.walletAddress).toBe(wallet.publicKey);
  });

  it("rejects a wallet that does not match the issued nonce", async () => {
    const { auth } = service();
    const wallet = generateWallet();
    const other = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const tampered = signed.message.replace(`Wallet: ${wallet.publicKey}`, `Wallet: ${other.publicKey}`);
    const signature = signMessage(tampered, other.secretKey);
    await expect(
      auth.login(
        { walletAddress: other.publicKey, message: tampered, signature },
        { now, correlationId: null },
      ),
    ).rejects.toMatchObject({ code: "AUTH_WALLET_MISMATCH" });
  });

  it("rejects an expired session", async () => {
    const { auth } = service({ nonce: 300, session: 60 });
    const wallet = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const session = await auth.login(
      { walletAddress: wallet.publicKey, message: signed.message, signature: signed.signature },
      { now, correlationId: null },
    );
    const later = new Date(now.getTime() + 61_000);
    await expect(auth.authenticate(session.token, { now: later, correlationId: null })).rejects.toMatchObject({
      code: "AUTH_SESSION_EXPIRED",
    });
  });

  it("rejects a revoked session", async () => {
    const { auth, audit } = service();
    const wallet = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const session = await auth.login(
      { walletAddress: wallet.publicKey, message: signed.message, signature: signed.signature },
      { now, correlationId: "c1" },
    );
    await auth.logout(session.token, { now, correlationId: "c2" });
    await expect(auth.authenticate(session.token, { now, correlationId: null })).rejects.toMatchObject({
      code: "AUTH_SESSION_REVOKED",
    });
    const events = await audit.list(10);
    expect(events.map((event) => event.action)).toEqual(["ACCOUNT_LOGIN", "ACCOUNT_LOGOUT"]);
  });

  it("serves login and logout over HTTP", async () => {
    const now = new Date("2026-10-03T12:00:00.000Z");
    const { app } = buildTestApp(() => now);
    const wallet = generateWallet();
    const nonceRes = await app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-1" },
      body: JSON.stringify({ walletAddress: wallet.publicKey }),
    });
    expect(nonceRes.status).toBe(201);
    expect(nonceRes.headers.get("x-request-id")).toBe("req-1");
    const issued = (await nonceRes.json()) as { message: string };
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet.publicKey,
        message: issued.message,
        signature: signMessage(issued.message, wallet.secretKey),
      }),
    });
    expect(loginRes.status).toBe(200);
    const login = (await loginRes.json()) as { token: string };
    const me = await app.request("/v1/me", {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(me.status).toBe(200);
    const logout = await app.request("/v1/auth/logout", {
      method: "POST",
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(logout.status).toBe(200);
    const again = await app.request("/v1/me", {
      headers: { authorization: `Bearer ${login.token}` },
    });
    expect(again.status).toBe(401);
    const body = (await again.json()) as { error: { code: string; stack?: string } };
    expect(body.error.code).toBe("AUTH_SESSION_REVOKED");
    expect(body.error.stack).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("stack");
  });

  it("does not store private keys or seed phrases", () => {
    const sql = readFileSync(
      path.resolve(process.cwd(), "migrations/001_phase1_identity_rbac_audit.sql"),
      "utf8",
    ).toLowerCase();
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("seed_phrase");
    expect(sql).not.toContain("escrow_signer");
  });
});

describe("auth error type", () => {
  it("uses AppError for signature failure", async () => {
    const { auth } = service();
    const wallet = generateWallet();
    const now = new Date("2026-10-03T12:00:00.000Z");
    const signed = await issueAndSign(auth, wallet, now);
    const error = await auth
      .login(
        { walletAddress: wallet.publicKey, message: signed.message, signature: "aaaa" },
        { now, correlationId: null },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AppError);
  });
});
