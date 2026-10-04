import type { AuditStore } from "../audit/types.js";
import { AppError } from "../shared/errors.js";

/**
 * A scoring operator must not approve a result they calculated.
 * Reviewer remains a separate capability. This does not grant settlement authority.
 */
export async function assertApproverIsNotCalculator(
  audit: AuditStore,
  settlementId: string,
  actorAccountId: string,
): Promise<void> {
  const calculated = await audit.query({
    limit: 50,
    entityId: settlementId,
    action: "RESULT_CALCULATED",
  });
  if (calculated.some((event) => event.actorAccountId === actorAccountId)) {
    throw new AppError(
      "SELF_APPROVAL",
      403,
      "A scoring operator cannot approve a result they calculated",
    );
  }
}
