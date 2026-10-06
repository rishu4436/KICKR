import { AppError } from "../shared/errors.js";

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{1,46}[A-Za-z0-9]$/;
const DISPLAY_RE = /^[A-Za-z0-9](?:[A-Za-z0-9 _.'-]{0,30}[A-Za-z0-9])?$/;

export function sanitizeLeagueName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 3 || name.length > 48 || !NAME_RE.test(name)) {
    throw new AppError("VALIDATION", 400, "League name must be 3–48 safe characters");
  }
  return name;
}

export function sanitizeDisplayName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 32 || !DISPLAY_RE.test(name)) {
    throw new AppError("VALIDATION", 400, "Display name must be 1–32 safe characters");
  }
  // Block monetary / claim language
  if (/\b(usdc|prize|claim|\$|payout|withdraw)\b/i.test(name)) {
    throw new AppError("VALIDATION", 400, "Display name looks monetary — pick another");
  }
  return name;
}
