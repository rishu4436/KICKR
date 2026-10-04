/** Fantasy positions. No extra tactical roles are defined. */
export const PLAYER_ROLES = ["GK", "DEF", "MID", "FWD"] as const;
export type PlayerRole = (typeof PLAYER_ROLES)[number];

export function isPlayerRole(value: string): value is PlayerRole {
  return (PLAYER_ROLES as readonly string[]).includes(value);
}
