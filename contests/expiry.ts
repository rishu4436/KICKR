/**
 * Whether a finalized deposit may confirm a reservation.
 * Chain time before expiry wins over a lazy EXPIRED mark (indexer lag).
 * A deposit at or after expiry, or with no proof and a passed wall clock, cannot confirm.
 * Null block time is not treated as finalized-before-expiry.
 */

export function confirmationAllowed(input: {
  reservationStatus: string;
  expiresAt: string;
  blockTime: number | null;
  now: Date;
}): boolean {
  if (input.reservationStatus === "CANCELLED" || input.reservationStatus === "CONFIRMED") {
    return false;
  }
  if (input.reservationStatus !== "PENDING" && input.reservationStatus !== "EXPIRED") {
    return false;
  }
  const expiresMs = Date.parse(input.expiresAt);
  if (input.blockTime !== null) {
    return input.blockTime * 1000 < expiresMs;
  }
  return input.now.getTime() < expiresMs && input.reservationStatus === "PENDING";
}
