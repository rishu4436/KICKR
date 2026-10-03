export interface AccountRecord {
  id: string;
  walletAddress: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

export interface LoginNonceRecord {
  id: string;
  nonce: string;
  walletAddress: string;
  domain: string;
  message: string;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  accountId: string;
  tokenHash: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface AccountRepository {
  findById(id: string): Promise<AccountRecord | null>;
  findByWallet(walletAddress: string): Promise<AccountRecord | null>;
  insert(account: AccountRecord): Promise<AccountRecord>;
}

export interface NonceRepository {
  insert(record: LoginNonceRecord): Promise<void>;
  findByNonce(nonce: string): Promise<LoginNonceRecord | null>;
  /** Single-use consume. Returns true only the first time, and only if unexpired. */
  consumeIfValid(nonce: string, now: Date): Promise<boolean>;
}

export interface SessionRepository {
  insert(session: SessionRecord): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** Returns true when this call transitioned the session to revoked. */
  revoke(sessionId: string, now: Date): Promise<boolean>;
}

export interface RequestContext {
  now: Date;
  correlationId: string | null;
}

export interface Principal {
  accountId: string;
  walletAddress: string;
  sessionId: string;
  expiresAt: Date;
}
