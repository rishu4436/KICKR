import type { AuditStore } from "../audit/types.js";
import { AppError } from "../shared/errors.js";
import { newId, newNonce, newSessionToken, sha256Hex } from "../shared/ids.js";
import { buildLoginMessage, parseLoginMessage } from "./message.js";
import { verifyWalletSignature } from "./signature.js";
import type {
  AccountRepository,
  NonceRepository,
  Principal,
  RequestContext,
  SessionRepository,
} from "./types.js";
import { canonicalizeWallet } from "./wallet.js";

export interface AuthConfig {
  domain: string;
  nonceTtlSeconds: number;
  sessionTtlSeconds: number;
}

export interface IssuedNonce {
  nonce: string;
  message: string;
  domain: string;
  expiresAt: string;
}

export interface LoginResult {
  token: string;
  tokenType: "Bearer";
  expiresAt: string;
  account: {
    id: string;
    walletAddress: string;
  };
}

export class AuthService {
  constructor(
    private readonly accounts: AccountRepository,
    private readonly nonces: NonceRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditStore,
    private readonly authConfig: AuthConfig,
  ) {}

  async issueNonce(wallet: string, ctx: RequestContext): Promise<IssuedNonce> {
    const walletAddress = canonicalizeWallet(wallet);
    const nonce = newNonce();
    const createdAt = ctx.now;
    const expiresAt = new Date(createdAt.getTime() + this.authConfig.nonceTtlSeconds * 1000);
    const message = buildLoginMessage({
      domain: this.authConfig.domain,
      walletAddress,
      nonce,
      expiresAt,
    });
    await this.nonces.insert({
      id: newId(),
      nonce,
      walletAddress,
      domain: this.authConfig.domain,
      message,
      expiresAt,
      consumedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    return {
      nonce,
      message,
      domain: this.authConfig.domain,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async login(
    input: { walletAddress: string; message: string; signature: string },
    ctx: RequestContext,
  ): Promise<LoginResult> {
    const walletAddress = canonicalizeWallet(input.walletAddress);
    const parsed = parseLoginMessage(input.message);
    if (!parsed) {
      throw new AppError("AUTH_MESSAGE_INVALID", 401, "Login message is invalid");
    }
    if (parsed.domain !== this.authConfig.domain) {
      throw new AppError("AUTH_DOMAIN_MISMATCH", 401, "Login domain does not match");
    }
    if (parsed.walletAddress !== walletAddress) {
      throw new AppError("AUTH_WALLET_MISMATCH", 401, "Login wallet does not match");
    }

    const record = await this.nonces.findByNonce(parsed.nonce);
    if (!record) {
      throw new AppError("AUTH_NONCE_INVALID", 401, "Login nonce is invalid");
    }
    if (record.domain !== this.authConfig.domain || parsed.domain !== record.domain) {
      throw new AppError("AUTH_DOMAIN_MISMATCH", 401, "Login domain does not match");
    }
    if (record.walletAddress !== walletAddress) {
      throw new AppError("AUTH_WALLET_MISMATCH", 401, "Login wallet does not match");
    }
    if (record.message !== input.message) {
      throw new AppError("AUTH_MESSAGE_MISMATCH", 401, "Login message does not match the issued nonce");
    }
    if (record.consumedAt) {
      throw new AppError("AUTH_NONCE_REUSED", 401, "Login nonce was already used");
    }
    if (record.expiresAt <= ctx.now) {
      throw new AppError("AUTH_NONCE_EXPIRED", 401, "Login nonce has expired");
    }
    if (!verifyWalletSignature(walletAddress, input.message, input.signature)) {
      throw new AppError("AUTH_INVALID_SIGNATURE", 401, "Login signature is invalid");
    }

    const consumed = await this.nonces.consumeIfValid(parsed.nonce, ctx.now);
    if (!consumed) {
      throw new AppError("AUTH_NONCE_REUSED", 401, "Login nonce was already used");
    }

    const account = await this.getOrCreateAccount(walletAddress, ctx.now);
    const token = newSessionToken();
    const sessionId = newId();
    const expiresAt = new Date(ctx.now.getTime() + this.authConfig.sessionTtlSeconds * 1000);
    await this.sessions.insert({
      id: sessionId,
      accountId: account.id,
      tokenHash: sha256Hex(token),
      createdAt: ctx.now,
      updatedAt: ctx.now,
      expiresAt,
      revokedAt: null,
    });

    await this.audit.append({
      action: "ACCOUNT_LOGIN",
      occurredAt: ctx.now,
      entityType: "ACCOUNT",
      entityId: account.id,
      metadata: { method: "solana_wallet", domain: this.authConfig.domain },
      actorAccountId: account.id,
      actorWallet: account.walletAddress,
      correlationId: ctx.correlationId,
    });

    return {
      token,
      tokenType: "Bearer",
      expiresAt: expiresAt.toISOString(),
      account: { id: account.id, walletAddress: account.walletAddress },
    };
  }

  async authenticate(token: string, ctx: RequestContext): Promise<Principal> {
    if (!token) {
      throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
    }
    const session = await this.sessions.findByTokenHash(sha256Hex(token));
    if (!session) {
      throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
    }
    if (session.revokedAt) {
      throw new AppError("AUTH_SESSION_REVOKED", 401, "Session has been revoked");
    }
    if (session.expiresAt <= ctx.now) {
      throw new AppError("AUTH_SESSION_EXPIRED", 401, "Session has expired");
    }
    const account = await this.requireAccount(session.accountId);
    return {
      accountId: account.id,
      walletAddress: account.walletAddress,
      sessionId: session.id,
      expiresAt: session.expiresAt,
    };
  }

  async logout(token: string, ctx: RequestContext): Promise<Principal> {
    const principal = await this.authenticate(token, ctx);
    const revoked = await this.sessions.revoke(principal.sessionId, ctx.now);
    if (!revoked) {
      throw new AppError("AUTH_SESSION_REVOKED", 401, "Session has been revoked");
    }
    await this.audit.append({
      action: "ACCOUNT_LOGOUT",
      occurredAt: ctx.now,
      entityType: "SESSION",
      entityId: principal.sessionId,
      metadata: { method: "solana_wallet" },
      actorAccountId: principal.accountId,
      actorWallet: principal.walletAddress,
      correlationId: ctx.correlationId,
    });
    return principal;
  }

  listAccounts() {
    return this.accounts.listAll();
  }

  suspendAccount(id: string, now: Date) {
    return this.accounts.suspend(id, now);
  }

  findAccount(id: string) {
    return this.accounts.findById(id);
  }

  listSessions(accountId: string) {
    return this.sessions.listByAccount(accountId);
  }

  findSession(sessionId: string) {
    return this.sessions.findById(sessionId);
  }

  revokeSessionById(sessionId: string, now: Date) {
    return this.sessions.revoke(sessionId, now);
  }

  private async getOrCreateAccount(walletAddress: string, now: Date) {
    const existing = await this.accounts.findByWallet(walletAddress);
    if (existing) {
      if (existing.deletedAt) {
        // TODO: account restore after soft-delete is unspecified.
        throw new AppError("ACCOUNT_DISABLED", 403, "Account is disabled");
      }
      return existing;
    }
    return this.accounts.insert({
      id: newId(),
      walletAddress,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
  }

  private async requireAccount(accountId: string) {
    const account = await this.accounts.findById(accountId);
    if (!account || account.deletedAt) {
      throw new AppError("UNAUTHENTICATED", 401, "Authentication required");
    }
    return account;
  }
}
