import { randomBytes } from "node:crypto";

const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Short invite code. Not a secret credential — just an unguessable join token. */
export function generateInviteCode(bytes = 8): string {
  const buf = randomBytes(bytes);
  let out = "";
  for (let i = 0; i < buf.length; i += 1) {
    out += ALPHABET[buf[i]! % ALPHABET.length];
  }
  return out;
}

export function normalizeInviteCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function invitePath(code: string): string {
  return `#/leagues/join/${normalizeInviteCode(code)}`;
}
