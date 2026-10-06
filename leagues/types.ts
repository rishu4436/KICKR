/** Private FREE leagues. Invite-based. Never monetary. */

export type PrivateLeagueStatus = "OPEN" | "FULL" | "LOCKED" | "COMPLETED";

export interface PrivateLeagueRecord {
  id: string;
  name: string;
  matchId: string;
  ownerAccountId: string;
  ownerWallet: string;
  inviteCode: string;
  capacity: number;
  memberCount: number;
  status: PrivateLeagueStatus;
  createdAt: string;
  updatedAt: string;
}

export interface PrivateLeagueMember {
  id: string;
  leagueId: string;
  accountId: string;
  wallet: string;
  teamVersionId: string;
  joinedAt: string;
}

export interface PrivateLeagueResultRow {
  memberId: string;
  wallet: string;
  teamVersionId: string;
  finalScoreMilliPoints: number;
  rank: number;
}

export interface PrivateLeagueResult {
  id: string;
  leagueId: string;
  matchId: string;
  status: "FINAL";
  rows: PrivateLeagueResultRow[];
  finalizedAt: string;
}

export interface PrivateLeagueView {
  id: string;
  name: string;
  matchId: string;
  ownerWallet: string;
  ownerAccountId: string;
  inviteCode: string;
  invitePath: string;
  capacity: number;
  memberCount: number;
  remaining: number;
  status: PrivateLeagueStatus;
  createdAt: string;
  lifecycleBucket: "upcoming" | "live" | "completed";
  isOwner: boolean;
  youJoined: boolean;
  free: true;
  monetary: false;
  payment: "FREE_NO_PAYMENT";
}

export interface PrivateLeagueLeaderboardRow {
  rank: number;
  wallet: string;
  teamVersionId: string;
  milliPoints: number;
  you: boolean;
}
