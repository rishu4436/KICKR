import type { RequestContext } from "../auth/types.js";
import type { ContestService } from "./service.js";

/**
 * Local lock interface. Replace the body with a distributed worker later.
 * Not a production scheduler: no lease, no multi-node election, no payout.
 */
export interface ContestLockScheduler {
  lockDue(now: Date, ctx: RequestContext): Promise<readonly string[]>;
}

export class LocalContestLockScheduler implements ContestLockScheduler {
  constructor(private readonly contests: ContestService) {}

  async lockDue(now: Date, ctx: RequestContext): Promise<readonly string[]> {
    return this.contests.lockDue(now, ctx);
  }
}
