/**
 * Production / non-local-dev refusal for the FREE E2E harness and scoring actor.
 * Config gate: NODE_ENV=production or SPORTS_DATA_PROVIDER≠local-dev → blocked.
 */
import { AppError } from "../../shared/errors.js";

export function isFreeDevHarnessAllowed(input: {
  nodeEnv: string;
  sportsDataProvider: string;
}): boolean {
  if (input.nodeEnv === "production") return false;
  if (input.sportsDataProvider !== "local-dev") return false;
  return true;
}

export function assertFreeDevHarnessAllowed(input: {
  nodeEnv: string;
  sportsDataProvider: string;
}): void {
  if (input.nodeEnv === "production") {
    throw new AppError(
      "DEV_HARNESS_BLOCKED",
      403,
      "Free E2E harness is blocked in production",
    );
  }
  if (input.sportsDataProvider !== "local-dev") {
    throw new AppError(
      "DEV_HARNESS_BLOCKED",
      403,
      "Free E2E harness requires SPORTS_DATA_PROVIDER=local-dev",
    );
  }
}
