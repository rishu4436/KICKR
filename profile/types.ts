export interface ProfileRecentContest {
  kind: "FREE_CONTEST" | "PRIVATE_LEAGUE";
  id: string;
  label: string;
  matchId: string;
  rank: number;
  scoreMilliPoints: number;
  finalizedAt: string;
  free: true;
  monetary: false;
}

export interface PlayerProfile {
  wallet: string;
  displayName: string | null;
  contestsPlayed: number;
  wins: number;
  top3Finishes: number;
  averagePoints: number;
  recentContests: ProfileRecentContest[];
  freeOnly: true;
  monetaryStats: false;
}
