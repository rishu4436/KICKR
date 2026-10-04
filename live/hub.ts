/**
 * In-process SSE fan-out for targeted live score updates.
 * Not a full-page poll. Multiple subscribers per match are supported.
 */

export interface LiveScoreUpdate {
  type: "score_update";
  matchId: string;
  eventId: string;
  eventType: string;
  playerId: string | null;
  timestamp: string;
  baseMilliPoints: number;
  multiplier: { numerator: number; denominator: number } | null;
  contributionMilliPoints: number;
  teamId: string | null;
  teamTotalMilliPoints: number | null;
  explanation: {
    event: string;
    playerId: string | null;
    basePoints: number;
    multiplierLabel: string | null;
    contribution: number;
    newTeamTotal: number | null;
  };
}

export interface LiveHealthUpdate {
  type: "health";
  matchId: string;
  connected: boolean;
  delayed: boolean;
  lastEventAgeMs: number | null;
  providerName: string | null;
  eventCount: number;
  freshness: string;
}

export type LiveHubMessage = LiveScoreUpdate | LiveHealthUpdate;

type Subscriber = (message: LiveHubMessage) => void;

export class LiveScoreHub {
  private readonly byMatch = new Map<string, Set<Subscriber>>();

  subscribe(matchId: string, subscriber: Subscriber): () => void {
    let set = this.byMatch.get(matchId);
    if (!set) {
      set = new Set();
      this.byMatch.set(matchId, set);
    }
    set.add(subscriber);
    return () => {
      set?.delete(subscriber);
      if (set && set.size === 0) {
        this.byMatch.delete(matchId);
      }
    };
  }

  publish(matchId: string, message: LiveHubMessage): void {
    const set = this.byMatch.get(matchId);
    if (!set) {
      return;
    }
    for (const subscriber of set) {
      try {
        subscriber(message);
      } catch {
        // Subscriber failures must not break scoring.
      }
    }
  }

  subscriberCount(matchId: string): number {
    return this.byMatch.get(matchId)?.size ?? 0;
  }
}
