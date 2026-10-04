/**
 * Squad credits are an integer selection budget.
 * They are not USDC, not escrow, and not a wallet balance.
 */

export function calculateCreditsUsed(
  credits: readonly number[],
): number {
  let total = 0;
  for (const credit of credits) {
    if (!Number.isInteger(credit)) {
      throw new Error("credits must be integers");
    }
    total += credit;
  }
  return total;
}

export function remainingCredits(used: number, cap: number): number {
  if (!Number.isInteger(used) || !Number.isInteger(cap)) {
    throw new Error("credits must be integers");
  }
  return cap - used;
}

export function validateCreditCap(used: number, cap: number): boolean {
  if (!Number.isInteger(used) || !Number.isInteger(cap)) {
    return false;
  }
  return used <= cap;
}
