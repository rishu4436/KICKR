import type {
  AccountRecord,
  AccountRepository,
  LoginNonceRecord,
  NonceRepository,
  SessionRecord,
  SessionRepository,
} from "./types.js";

/** Test double. Not authoritative. Production uses Postgres. */
export class InMemoryAccountRepository implements AccountRepository {
  private readonly byWallet = new Map<string, AccountRecord>();
  private readonly byId = new Map<string, AccountRecord>();

  async findById(id: string): Promise<AccountRecord | null> {
    const row = this.byId.get(id);
    return row ? { ...row } : null;
  }

  async findByWallet(walletAddress: string): Promise<AccountRecord | null> {
    const row = this.byWallet.get(walletAddress);
    return row ? { ...row } : null;
  }

  async insert(account: AccountRecord): Promise<AccountRecord> {
    if (this.byWallet.has(account.walletAddress)) {
      throw new Error("account already exists");
    }
    const copy = { ...account };
    this.byWallet.set(account.walletAddress, copy);
    this.byId.set(account.id, copy);
    return { ...account };
  }

  async listAll(): Promise<AccountRecord[]> {
    return [...this.byId.values()].map((row) => ({ ...row }));
  }

  async suspend(id: string, now: Date): Promise<boolean> {
    const row = this.byId.get(id);
    if (!row || row.deletedAt) {
      return false;
    }
    row.deletedAt = now;
    row.updatedAt = now;
    return true;
  }
}

export class InMemoryNonceRepository implements NonceRepository {
  private readonly byNonce = new Map<string, LoginNonceRecord>();

  async insert(record: LoginNonceRecord): Promise<void> {
    if (this.byNonce.has(record.nonce)) {
      throw new Error("nonce already exists");
    }
    this.byNonce.set(record.nonce, { ...record });
  }

  async findByNonce(nonce: string): Promise<LoginNonceRecord | null> {
    const row = this.byNonce.get(nonce);
    return row ? { ...row } : null;
  }

  async consumeIfValid(nonce: string, now: Date): Promise<boolean> {
    const row = this.byNonce.get(nonce);
    if (!row || row.consumedAt || row.expiresAt <= now) {
      return false;
    }
    row.consumedAt = now;
    row.updatedAt = now;
    return true;
  }
}

export class InMemorySessionRepository implements SessionRepository {
  private readonly byHash = new Map<string, SessionRecord>();
  private readonly byId = new Map<string, SessionRecord>();

  async insert(session: SessionRecord): Promise<void> {
    const copy = { ...session };
    this.byHash.set(session.tokenHash, copy);
    this.byId.set(session.id, copy);
  }

  async findByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    const row = this.byHash.get(tokenHash);
    return row ? { ...row } : null;
  }

  async findById(sessionId: string): Promise<SessionRecord | null> {
    const row = this.byId.get(sessionId);
    return row ? { ...row } : null;
  }

  async listByAccount(accountId: string): Promise<SessionRecord[]> {
    return [...this.byId.values()]
      .filter((row) => row.accountId === accountId)
      .map((row) => ({ ...row }));
  }

  async revoke(sessionId: string, now: Date): Promise<boolean> {
    const row = this.byId.get(sessionId);
    if (!row || row.revokedAt || row.expiresAt <= now) {
      return false;
    }
    row.revokedAt = now;
    row.updatedAt = now;
    return true;
  }
}
