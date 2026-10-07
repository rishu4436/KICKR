import type { PlayerRole } from "../domain/football/roles.js";

/**
 * Sportmonks Football position_id → KICKR fantasy role.
 * Fail visibly on unsupported mappings (do not guess).
 *
 * 24 Goalkeeper, 25 Defender, 26 Midfielder, 27 Attacker
 */
export const SPORTMONKS_POSITION_MAP: Record<number, PlayerRole> = {
  24: "GK",
  25: "DEF",
  26: "MID",
  27: "FWD",
};

export class UnsupportedPositionError extends Error {
  constructor(
    readonly positionId: number | string | null,
    message?: string,
  ) {
    super(
      message ??
        `Unsupported Sportmonks position_id ${String(positionId)} — expected 24/25/26/27 (GK/DEF/MID/FWD)`,
    );
    this.name = "UnsupportedPositionError";
  }
}

export function mapSportmonksPosition(positionId: number | string | null | undefined): PlayerRole {
  if (positionId === null || positionId === undefined || positionId === "") {
    throw new UnsupportedPositionError(null, "Missing Sportmonks position_id");
  }
  const n = typeof positionId === "number" ? positionId : Number(positionId);
  if (!Number.isFinite(n) || !(n in SPORTMONKS_POSITION_MAP)) {
    throw new UnsupportedPositionError(positionId);
  }
  return SPORTMONKS_POSITION_MAP[n]!;
}

export function tryMapSportmonksPosition(
  positionId: number | string | null | undefined,
): PlayerRole | null {
  try {
    return mapSportmonksPosition(positionId);
  } catch {
    return null;
  }
}
