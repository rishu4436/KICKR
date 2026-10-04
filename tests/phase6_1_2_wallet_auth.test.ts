/**
 * Phase 6.1.2 wallet auth (UNIT TEST / LOCAL FIXTURE labelled).
 * Mock wallets are UNIT TEST only — not a browser Phantom E2E.
 */
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  assertWalletClaimInvariant,
  createMockWalletAdapter,
  loginWithBrowserWallet,
  shortWallet,
} from "../app/src/claim-flow.js";
import { buildTestApp, generateWallet, signMessage } from "./helpers.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { InMemorySettlementStore } from "../settlement/memory-store.js";
import { SettlementService } from "../settlement/service.js";
import { buildClaimPlan } from "../solana/escrow.js";

const PROGRAM = "DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN";
const MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ENTRY_A = "a0000000-0000-4000-8000-000000000001";
const ENTRY_B = "a0000000-0000-4000-8000-000000000002";
const CONTEST = "c0000000-0000-4000-8000-000000000099";
const MATCH = "m0000000-0000-4000-8000-000000000099";

const feePolicy = {
  id: "51000000-0000-4000-8000-000000000001",
  version: 1,
  rateBps: 1000,
  label: "DEV",
};
const h2hPolicy = {
  id: "52000000-0000-4000-8000-000000000001",
  version: 1,
  policyType: "HEAD_TO_HEAD" as const,
  configuration: { calculation: "winner_takes_prize_pool", tiePolicy: "entry_id_asc" },
};

function entry(entryId: string, score: number, wallet: string) {
  return {
    entryId,
    teamVersionId: "t0000000-0000-4000-8000-000000000001",
    destinationWallet: wallet,
    baseScoreMilliPoints: score,
    finalScoreMilliPoints: score,
    xi: Array.from({ length: 11 }, (_, i) => `p${i}`),
    captainId: "p0",
    viceId: "p1",
  };
}

describe("Phase 6.1.2 wallet auth (UNIT TEST)", () => {
  it("dev signer nacl path still produces a valid login session shape", async () => {
    const { app } = buildTestApp(() => new Date("2026-10-04T12:00:00.000Z"));
    const pair = nacl.sign.keyPair();
    const walletAddress = bs58.encode(pair.publicKey);
    const nonceRes = await app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress }),
    });
    expect(nonceRes.status).toBe(201);
    const nonce = (await nonceRes.json()) as { message: string };
    const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(nonce.message), pair.secretKey));
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress, message: nonce.message, signature }),
    });
    expect(loginRes.status).toBe(200);
    const session = (await loginRes.json()) as { token: string; account: { walletAddress: string } };
    expect(session.account.walletAddress).toBe(walletAddress);
    expect(session.token.length).toBeGreaterThan(10);
  });

  it("nonce auth via loginWithBrowserWallet (mock wallet UNIT TEST)", async () => {
    const { app } = buildTestApp(() => new Date("2026-10-04T12:00:00.000Z"));
    const kp = Keypair.generate();
    const mock = createMockWalletAdapter({
      keypair: kp,
      signMessageFn: async (message) => signMessage(message, kp.secretKey),
    });
    const result = await loginWithBrowserWallet({
      wallet: mock,
      requestNonce: async (walletAddress) => {
        const res = await app.request("/v1/auth/nonce", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walletAddress }),
        });
        return (await res.json()) as { message: string };
      },
      requestLogin: async (body) => {
        const res = await app.request("/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) throw new Error(`login ${res.status}`);
        return (await res.json()) as { token: string; account: { walletAddress: string } };
      },
    });
    expect(result.walletAddress).toBe(kp.publicKey.toBase58());
    expect(mock.lastMessage).toContain("KICKR");
  });

  it("unsigned / empty signature rejected by login", async () => {
    const { app } = buildTestApp(() => new Date("2026-10-04T12:00:00.000Z"));
    const wallet = generateWallet();
    const nonceRes = await app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey }),
    });
    const nonce = (await nonceRes.json()) as { message: string };
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey, message: nonce.message, signature: "" }),
    });
    expect(loginRes.status).toBeGreaterThanOrEqual(400);
  });

  it("invalid signature rejected", async () => {
    const { app } = buildTestApp(() => new Date("2026-10-04T12:00:00.000Z"));
    const wallet = generateWallet();
    const other = generateWallet();
    const nonceRes = await app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey }),
    });
    const nonce = (await nonceRes.json()) as { message: string };
    const badSig = signMessage(nonce.message, other.secretKey);
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey, message: nonce.message, signature: badSig }),
    });
    expect(loginRes.status).toBe(401);
  });

  it("principal equals connected pubkey after mock wallet login", async () => {
    const { app } = buildTestApp(() => new Date("2026-10-04T12:00:00.000Z"));
    const kp = Keypair.generate();
    const mock = createMockWalletAdapter({
      keypair: kp,
      signMessageFn: async (message) => signMessage(message, kp.secretKey),
    });
    const session = await loginWithBrowserWallet({
      wallet: mock,
      requestNonce: async (walletAddress) => {
        const res = await app.request("/v1/auth/nonce", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walletAddress }),
        });
        return (await res.json()) as { message: string };
      },
      requestLogin: async (body) => {
        const res = await app.request("/v1/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return (await res.json()) as { token: string; account: { walletAddress: string } };
      },
    });
    const me = await app.request("/v1/me", { headers: { authorization: `Bearer ${session.token}` } });
    const body = (await me.json()) as { walletAddress: string };
    expect(body.walletAddress).toBe(kp.publicKey.toBase58());
  });

  it("wallet_mismatch invariant blocks claim when wallets differ", () => {
    expect(() =>
      assertWalletClaimInvariant({
        principalWallet: "Aaa",
        connectedWallet: "Bbb",
        destinationWallet: "Aaa",
      }),
    ).toThrow(/wallet_mismatch/);
    expect(() =>
      assertWalletClaimInvariant({
        principalWallet: "Aaa",
        connectedWallet: "Aaa",
        destinationWallet: "Ccc",
      }),
    ).toThrow(/wallet_mismatch/);
    expect(() =>
      assertWalletClaimInvariant({
        principalWallet: "Aaa",
        connectedWallet: "Aaa",
        destinationWallet: "Aaa",
      }),
    ).not.toThrow();
    expect(shortWallet("GjJYQen9kw4K3ETpeKCTbxvmfzDSYPJoG2Wy3kC9Je5S")).toMatch(/GjJY…Je5S/);
  });
});

describe("Phase 6.1.2 owner-scoped my-result / claim (LOCAL FIXTURE)", () => {
  async function login(app: ReturnType<typeof buildTestApp>["app"], wallet: ReturnType<typeof generateWallet>) {
    const nonceRes = await app.request("/v1/auth/nonce", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress: wallet.publicKey }),
    });
    const nonce = (await nonceRes.json()) as { message: string };
    const loginRes = await app.request("/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        walletAddress: wallet.publicKey,
        message: nonce.message,
        signature: signMessage(nonce.message, wallet.secretKey),
      }),
    });
    const session = (await loginRes.json()) as { token: string };
    return session.token;
  }

  it("other wallet cannot fetch claim proof; owner can", async () => {
    const clock = () => new Date("2026-10-04T12:00:00.000Z");
    const { app, deps } = buildTestApp(clock);
    deps.config.server.solana.usdcMint = MINT;
    deps.config.public.usdcMint = MINT;
    const alice = generateWallet();
    const bob = generateWallet();
    const aliceToken = await login(app, alice);
    const bobToken = await login(app, bob);

    const calc = await deps.settlement!.calculate({
      contestId: CONTEST,
      matchId: MATCH,
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: { frozen: true },
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: [entry(ENTRY_A, 9000, alice.publicKey), entry(ENTRY_B, 1000, bob.publicKey)],
      actorId: "actor",
      nowIso: clock().toISOString(),
    });
    await deps.settlement!.review(calc.id, "reviewer", clock().toISOString());
    await deps.settlement!.approve(calc.id, "reviewer", clock().toISOString());
    const prep = await deps.settlement!.prepare(calc.id, clock().toISOString());
    await deps.settlement!.markSubmitted(prep.id, "c-sig", clock().toISOString());
    await deps.settlement!.markConfirmed(prep.id, 1, clock().toISOString());

    const bobTries = await app.request(`/entries/${ENTRY_A}/claim?contestId=${CONTEST}`, {
      headers: { authorization: `Bearer ${bobToken}` },
    });
    expect(bobTries.status).toBe(403);

    const aliceOk = await app.request(`/entries/${ENTRY_A}/claim?contestId=${CONTEST}`, {
      headers: { authorization: `Bearer ${aliceToken}` },
    });
    expect(aliceOk.status).toBe(200);
    const plan = (await aliceOk.json()) as { destinationWallet: string; amountBaseUnits: number };
    expect(plan.destinationWallet).toBe(alice.publicKey);
    expect(plan.amountBaseUnits).toBe(9_000_000);

    // Signing uses authenticated claimant destination in ClaimPlan
    const built = buildClaimPlan({
      config: {
        programId: PROGRAM,
        usdcMint: MINT,
        usdcDecimals: 6,
        cluster: "devnet",
        tokenProgramId: TOKEN_PROGRAM_ID.toBase58(),
      },
      contestId: CONTEST,
      settlementId: prep.id,
      settlementVersion: prep.settlementVersion,
      entryId: ENTRY_A,
      amountBaseUnits: plan.amountBaseUnits,
      destinationWallet: plan.destinationWallet,
      merkleRoot: prep.merkleRoot!,
      resultHash: prep.resultHash,
      proof: [],
      claimStatus: "UNCLAIMED",
      claimSignature: null,
    });
    expect(built.destinationWallet).toBe(alice.publicKey);
  });

  it("my-result is owner-scoped (404 without confirmed entry for caller)", async () => {
    const clock = () => new Date("2026-10-04T12:00:00.000Z");
    const { app } = buildTestApp(clock);
    const stranger = generateWallet();
    const token = await login(app, stranger);
    const res = await app.request(`/contests/${CONTEST}/my-result`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // No confirmed entry for stranger → NOT_FOUND (owner-scoped)
    expect(res.status).toBe(404);
  });
});

describe("Phase 6.1.2 settlement service replay still green (smoke)", () => {
  it("ALREADY_CLAIMED on second claim", async () => {
    const store = new InMemorySettlementStore();
    const service = new SettlementService(store);
    const w1 = Keypair.generate().publicKey.toBase58();
    const w2 = Keypair.generate().publicKey.toBase58();
    const calculated = await service.calculate({
      contestId: CONTEST,
      matchId: MATCH,
      matchSettlementGate: "FINAL",
      entryFeeBaseUnits: 5_000_000,
      seatCount: 2,
      contestRules: { frozen: true },
      rulesetName: "DEV_V1",
      rulesetVersion: 1,
      feePolicy,
      payoutPolicy: h2hPolicy,
      entries: [entry(ENTRY_A, 9000, w1), entry(ENTRY_B, 1000, w2)],
      actorId: "actor",
      nowIso: "2026-10-04T00:00:00.000Z",
    });
    await service.review(calculated.id, "r", "2026-10-04T00:01:00.000Z");
    await service.approve(calculated.id, "r", "2026-10-04T00:02:00.000Z");
    const prepared = await service.prepare(calculated.id, "2026-10-04T00:03:00.000Z");
    await service.markClaimed(prepared.id, ENTRY_A, "sig-1", "2026-10-04T00:04:00.000Z");
    await expect(service.markClaimed(prepared.id, ENTRY_A, "sig-2", "2026-10-04T00:05:00.000Z")).rejects.toThrow(
      /already claimed/i,
    );
  });
});
