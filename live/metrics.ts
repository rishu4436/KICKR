/** In-memory live scoring / ingestion diagnostics for operators. */

export interface LiveMetricsSnapshot {
  providerLatencyMsLast: number | null;
  providerLatencyMsAvg: number | null;
  providerErrors: number;
  ingestionLagMs: number | null;
  lastSuccessfulPollAt: string | null;
  unresolvedPlayerMappings: number;
  duplicateEventsRejected: number;
  correctionsReceived: number;
  scoringRecomputations: number;
  redisRebuilds: number;
  staleMatches: number;
  eventsAccepted: number;
  pollsAttempted: number;
  liveProviderConfigured: boolean;
  providerName: string | null;
}

export class LiveMetrics {
  private latencySamples: number[] = [];
  private providerErrors = 0;
  private ingestionLagMs: number | null = null;
  private lastSuccessfulPollAt: string | null = null;
  private unresolvedPlayerMappings = 0;
  private duplicateEventsRejected = 0;
  private correctionsReceived = 0;
  private scoringRecomputations = 0;
  private redisRebuilds = 0;
  private staleMatches = 0;
  private eventsAccepted = 0;
  private pollsAttempted = 0;
  private liveProviderConfigured = false;
  private providerName: string | null = null;

  setProvider(name: string | null, configured: boolean): void {
    this.providerName = name;
    this.liveProviderConfigured = configured;
  }

  recordLatency(ms: number): void {
    this.latencySamples.push(ms);
    if (this.latencySamples.length > 100) {
      this.latencySamples.shift();
    }
  }

  recordProviderError(): void {
    this.providerErrors += 1;
  }

  recordPollSuccess(now: Date, lagMs: number | null): void {
    this.lastSuccessfulPollAt = now.toISOString();
    this.ingestionLagMs = lagMs;
    this.pollsAttempted += 1;
  }

  recordPollAttempt(): void {
    this.pollsAttempted += 1;
  }

  recordUnresolvedPlayer(): void {
    this.unresolvedPlayerMappings += 1;
  }

  recordDuplicate(): void {
    this.duplicateEventsRejected += 1;
  }

  recordCorrection(): void {
    this.correctionsReceived += 1;
  }

  recordRecompute(): void {
    this.scoringRecomputations += 1;
  }

  recordRedisRebuild(): void {
    this.redisRebuilds += 1;
  }

  setStaleMatches(count: number): void {
    this.staleMatches = count;
  }

  recordAccepted(): void {
    this.eventsAccepted += 1;
  }

  snapshot(): LiveMetricsSnapshot {
    const last = this.latencySamples.at(-1) ?? null;
    const avg =
      this.latencySamples.length === 0
        ? null
        : Math.round(
            this.latencySamples.reduce((sum, value) => sum + value, 0) / this.latencySamples.length,
          );
    return {
      providerLatencyMsLast: last,
      providerLatencyMsAvg: avg,
      providerErrors: this.providerErrors,
      ingestionLagMs: this.ingestionLagMs,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
      unresolvedPlayerMappings: this.unresolvedPlayerMappings,
      duplicateEventsRejected: this.duplicateEventsRejected,
      correctionsReceived: this.correctionsReceived,
      scoringRecomputations: this.scoringRecomputations,
      redisRebuilds: this.redisRebuilds,
      staleMatches: this.staleMatches,
      eventsAccepted: this.eventsAccepted,
      pollsAttempted: this.pollsAttempted,
      liveProviderConfigured: this.liveProviderConfigured,
      providerName: this.providerName,
    };
  }
}
