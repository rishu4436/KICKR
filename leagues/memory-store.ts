import { AppError } from "../shared/errors.js";
import { newId } from "../shared/ids.js";
import type {
  PrivateLeagueMember,
  PrivateLeagueRecord,
  PrivateLeagueResult,
  PrivateLeagueStatus,
} from "./types.js";

export interface LeagueStore {
  createLeague(input: {
    name: string;
    matchId: string;
    ownerAccountId: string;
    ownerWallet: string;
    inviteCode: string;
    capacity: number;
    now: Date;
  }): Promise<PrivateLeagueRecord>;
  getById(id: string): Promise<PrivateLeagueRecord | null>;
  getByInviteCode(code: string): Promise<PrivateLeagueRecord | null>;
  listByMatch(matchId: string): Promise<PrivateLeagueRecord[]>;
  listOwned(ownerAccountId: string): Promise<PrivateLeagueRecord[]>;
  listJoined(wallet: string): Promise<PrivateLeagueRecord[]>;
  join(input: {
    leagueId: string;
    accountId: string;
    wallet: string;
    teamVersionId: string;
    now: Date;
  }): Promise<{ league: PrivateLeagueRecord; member: PrivateLeagueMember; created: boolean }>;
  listMembers(leagueId: string): Promise<PrivateLeagueMember[]>;
  getMember(leagueId: string, wallet: string): Promise<PrivateLeagueMember | null>;
  setStatus(leagueId: string, status: PrivateLeagueStatus, now: Date): Promise<PrivateLeagueRecord | null>;
  getResult(leagueId: string): Promise<PrivateLeagueResult | null>;
  saveResult(result: PrivateLeagueResult): Promise<PrivateLeagueResult>;
  listResultsForWallet(wallet: string): Promise<PrivateLeagueResult[]>;
}

export class InMemoryLeagueStore implements LeagueStore {
  private readonly leagues = new Map<string, PrivateLeagueRecord>();
  private readonly byInvite = new Map<string, string>();
  private readonly members = new Map<string, PrivateLeagueMember[]>();
  private readonly results = new Map<string, PrivateLeagueResult>();

  async createLeague(input: {
    name: string;
    matchId: string;
    ownerAccountId: string;
    ownerWallet: string;
    inviteCode: string;
    capacity: number;
    now: Date;
  }): Promise<PrivateLeagueRecord> {
    if (this.byInvite.has(input.inviteCode)) {
      throw new AppError("INVITE_COLLISION", 409, "Invite code collision — retry");
    }
    const iso = input.now.toISOString();
    const row: PrivateLeagueRecord = {
      id: newId(),
      name: input.name,
      matchId: input.matchId,
      ownerAccountId: input.ownerAccountId,
      ownerWallet: input.ownerWallet,
      inviteCode: input.inviteCode,
      capacity: input.capacity,
      memberCount: 0,
      status: "OPEN",
      createdAt: iso,
      updatedAt: iso,
    };
    this.leagues.set(row.id, row);
    this.byInvite.set(row.inviteCode, row.id);
    this.members.set(row.id, []);
    return { ...row };
  }

  async getById(id: string): Promise<PrivateLeagueRecord | null> {
    const row = this.leagues.get(id);
    return row ? { ...row } : null;
  }

  async getByInviteCode(code: string): Promise<PrivateLeagueRecord | null> {
    const id = this.byInvite.get(code);
    if (!id) return null;
    return this.getById(id);
  }

  async listByMatch(matchId: string): Promise<PrivateLeagueRecord[]> {
    return [...this.leagues.values()].filter((l) => l.matchId === matchId).map((l) => ({ ...l }));
  }

  async listOwned(ownerAccountId: string): Promise<PrivateLeagueRecord[]> {
    return [...this.leagues.values()]
      .filter((l) => l.ownerAccountId === ownerAccountId)
      .map((l) => ({ ...l }));
  }

  async listJoined(wallet: string): Promise<PrivateLeagueRecord[]> {
    const out: PrivateLeagueRecord[] = [];
    for (const [leagueId, members] of this.members) {
      if (members.some((m) => m.wallet === wallet)) {
        const league = this.leagues.get(leagueId);
        if (league) out.push({ ...league });
      }
    }
    return out;
  }

  async join(input: {
    leagueId: string;
    accountId: string;
    wallet: string;
    teamVersionId: string;
    now: Date;
  }): Promise<{ league: PrivateLeagueRecord; member: PrivateLeagueMember; created: boolean }> {
    const league = this.leagues.get(input.leagueId);
    if (!league) throw new AppError("NOT_FOUND", 404, "Not found");
    const list = this.members.get(input.leagueId) ?? [];
    const existing = list.find((m) => m.wallet === input.wallet || m.accountId === input.accountId);
    if (existing) {
      throw new AppError("DUPLICATE_JOIN", 409, "Already joined this league");
    }
    if (league.status !== "OPEN" || league.memberCount >= league.capacity) {
      throw new AppError("LEAGUE_FULL", 409, "League is full");
    }
    const member: PrivateLeagueMember = {
      id: newId(),
      leagueId: input.leagueId,
      accountId: input.accountId,
      wallet: input.wallet,
      teamVersionId: input.teamVersionId,
      joinedAt: input.now.toISOString(),
    };
    list.push(member);
    this.members.set(input.leagueId, list);
    league.memberCount += 1;
    league.updatedAt = input.now.toISOString();
    if (league.memberCount >= league.capacity) {
      league.status = "FULL";
    }
    return { league: { ...league }, member: { ...member }, created: true };
  }

  async listMembers(leagueId: string): Promise<PrivateLeagueMember[]> {
    return (this.members.get(leagueId) ?? []).map((m) => ({ ...m }));
  }

  async getMember(leagueId: string, wallet: string): Promise<PrivateLeagueMember | null> {
    const row = (this.members.get(leagueId) ?? []).find((m) => m.wallet === wallet);
    return row ? { ...row } : null;
  }

  async setStatus(leagueId: string, status: PrivateLeagueStatus, now: Date): Promise<PrivateLeagueRecord | null> {
    const league = this.leagues.get(leagueId);
    if (!league) return null;
    league.status = status;
    league.updatedAt = now.toISOString();
    return { ...league };
  }

  async getResult(leagueId: string): Promise<PrivateLeagueResult | null> {
    const row = this.results.get(leagueId);
    return row ? { ...row, rows: row.rows.map((r) => ({ ...r })) } : null;
  }

  async saveResult(result: PrivateLeagueResult): Promise<PrivateLeagueResult> {
    const existing = this.results.get(result.leagueId);
    if (existing) return { ...existing, rows: existing.rows.map((r) => ({ ...r })) };
    this.results.set(result.leagueId, { ...result, rows: result.rows.map((r) => ({ ...r })) });
    const league = this.leagues.get(result.leagueId);
    if (league) {
      league.status = "COMPLETED";
      league.updatedAt = result.finalizedAt;
    }
    return { ...result, rows: result.rows.map((r) => ({ ...r })) };
  }

  async listResultsForWallet(wallet: string): Promise<PrivateLeagueResult[]> {
    const out: PrivateLeagueResult[] = [];
    for (const result of this.results.values()) {
      if (result.rows.some((r) => r.wallet === wallet)) {
        out.push({ ...result, rows: result.rows.map((r) => ({ ...r })) });
      }
    }
    return out;
  }
}
