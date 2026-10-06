/**
 * Dedicated LOCAL_DEV scoring actor for FREE finalize.
 *
 * - Not a matrix role or capability (cannot be granted via ops APIs).
 * - Exists only when the free E2E harness registers it under the production gate.
 * - Audited on issue and on each finalize use.
 * - Never grants or implies RUN_SETTLEMENT.
 */
import type { AuditStore } from "../../audit/types.js";
import { AppError } from "../../shared/errors.js";
import { assertFreeDevHarnessAllowed } from "./dev-gate.js";

export class LocalDevScoringActorRegistry {
  private readonly actors = new Set<string>();

  constructor(
    private readonly env: { nodeEnv: string; sportsDataProvider: string },
    private readonly audit: AuditStore,
  ) {}

  /** True when this process may register / accept local-dev scorers. */
  allowed(): boolean {
    return this.env.nodeEnv !== "production" && this.env.sportsDataProvider === "local-dev";
  }

  async register(
    accountId: string,
    ctx: { now: Date; correlationId: string | null },
  ): Promise<void> {
    assertFreeDevHarnessAllowed(this.env);
    this.actors.add(accountId);
    await this.audit.append({
      action: "LOCAL_DEV_SCORER_ISSUED",
      occurredAt: ctx.now,
      entityType: "ACCOUNT",
      entityId: accountId,
      metadata: {
        label: "LOCAL_DEV scoring actor",
        notSportmonks: true,
        runSettlement: false,
        note: "Harness-only. Not grantable via ops. Not a matrix capability.",
      },
      actorAccountId: accountId,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });
  }

  isActor(accountId: string): boolean {
    return this.allowed() && this.actors.has(accountId);
  }

  async assertCanFinalize(
    accountId: string,
    contestId: string,
    ctx: { now: Date; correlationId: string | null },
  ): Promise<void> {
    if (!this.allowed() || !this.actors.has(accountId)) {
      throw new AppError("FORBIDDEN", 403, "Local-dev scoring actor required");
    }
    await this.audit.append({
      action: "LOCAL_DEV_FREE_FINALIZE",
      occurredAt: ctx.now,
      entityType: "CONTEST",
      entityId: contestId,
      metadata: {
        scoringActorAccountId: accountId,
        label: "LOCAL_DEV free finalize",
        notSportmonks: true,
        runSettlement: false,
      },
      actorAccountId: accountId,
      actorWallet: null,
      correlationId: ctx.correlationId,
    });
  }

  /** Test helper. */
  clear(): void {
    this.actors.clear();
  }

  size(): number {
    return this.actors.size;
  }
}
