import { DEV_V1_RULESET } from "../domain/scoring/dev-v1.js";
import { newId } from "../shared/ids.js";
import type { FantasyTeamVersionRecord } from "../football/store.js";

/**
 * Phase 5.1 / Phase 6 boundary.
 * raw events → deterministic recompute → immutable APPROVED snapshot → (Phase 6) settlement.
 * This module does not settle, pay, claim, or move USDC.
 */

export type SnapshotStatus = "DRAFT" | "APPROVED";

export interface ApprovedResultSnapshotPayload {
  matchId: string;
  contestId: string;
  entryId: string;
  teamVersionId: string;
  rulesetName: string;
  rulesetVersion: number;
  exactXi: string[];
  captainId: string;
  viceId: string;
  finalScoreMilliPoints: number;
  ranking: number | null;
  scoreCalculation: {
    playerScores: Array<{
      playerId: string;
      baseMilliPoints: number;
      milliPoints: number;
      role: "captain" | "vice" | "player";
    }>;
    scale: number;
  };
  dataFinalizationState: string;
  snapshotTimestamp: string;
}

export interface ResultSnapshotRecord {
  id: string;
  matchId: string;
  contestId: string;
  entryId: string;
  teamVersionId: string;
  rulesetName: string;
  rulesetVersion: number;
  status: SnapshotStatus;
  approvedAt: string | null;
  dataFinalizationState: string;
  snapshot: ApprovedResultSnapshotPayload;
  createdAt: string;
}

export interface SnapshotStore {
  insertDraft(row: ResultSnapshotRecord): Promise<void>;
  approve(id: string, approvedAt: string): Promise<ResultSnapshotRecord>;
  get(id: string): Promise<ResultSnapshotRecord | null>;
  getApprovedForEntry(entryId: string): Promise<ResultSnapshotRecord | null>;
  listByMatch(matchId: string): Promise<ResultSnapshotRecord[]>;
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly rows = new Map<string, ResultSnapshotRecord>();

  async insertDraft(row: ResultSnapshotRecord): Promise<void> {
    if (row.status !== "DRAFT") {
      throw new Error("only DRAFT snapshots may be inserted");
    }
    this.rows.set(row.id, structuredClone(row));
  }

  async approve(id: string, approvedAt: string): Promise<ResultSnapshotRecord> {
    const row = this.rows.get(id);
    if (!row) {
      throw new Error("snapshot not found");
    }
    if (row.status === "APPROVED") {
      throw new Error("approved snapshots are immutable and must not be regenerated");
    }
    const existing = [...this.rows.values()].find(
      (item) => item.entryId === row.entryId && item.status === "APPROVED",
    );
    if (existing) {
      throw new Error("entry already has an APPROVED snapshot");
    }
    const approved: ResultSnapshotRecord = {
      ...row,
      status: "APPROVED",
      approvedAt,
      snapshot: { ...row.snapshot, snapshotTimestamp: approvedAt },
    };
    this.rows.set(id, approved);
    return structuredClone(approved);
  }

  async get(id: string): Promise<ResultSnapshotRecord | null> {
    const row = this.rows.get(id);
    return row ? structuredClone(row) : null;
  }

  async getApprovedForEntry(entryId: string): Promise<ResultSnapshotRecord | null> {
    const row = [...this.rows.values()].find(
      (item) => item.entryId === entryId && item.status === "APPROVED",
    );
    return row ? structuredClone(row) : null;
  }

  async listByMatch(matchId: string): Promise<ResultSnapshotRecord[]> {
    return [...this.rows.values()]
      .filter((row) => row.matchId === matchId)
      .map((row) => structuredClone(row));
  }
}

export function buildDraftSnapshot(input: {
  matchId: string;
  contestId: string;
  entryId: string;
  version: FantasyTeamVersionRecord;
  finalScoreMilliPoints: number;
  ranking: number | null;
  playerScores: ApprovedResultSnapshotPayload["scoreCalculation"]["playerScores"];
  dataFinalizationState: string;
  nowIso: string;
}): ResultSnapshotRecord {
  const payload: ApprovedResultSnapshotPayload = {
    matchId: input.matchId,
    contestId: input.contestId,
    entryId: input.entryId,
    teamVersionId: input.version.id,
    rulesetName: DEV_V1_RULESET.name,
    rulesetVersion: DEV_V1_RULESET.version,
    exactXi: [...input.version.playerIds],
    captainId: input.version.captainId,
    viceId: input.version.viceId,
    finalScoreMilliPoints: input.finalScoreMilliPoints,
    ranking: input.ranking,
    scoreCalculation: {
      playerScores: input.playerScores,
      scale: DEV_V1_RULESET.scale,
    },
    dataFinalizationState: input.dataFinalizationState,
    snapshotTimestamp: input.nowIso,
  };
  return {
    id: newId(),
    matchId: input.matchId,
    contestId: input.contestId,
    entryId: input.entryId,
    teamVersionId: input.version.id,
    rulesetName: DEV_V1_RULESET.name,
    rulesetVersion: DEV_V1_RULESET.version,
    status: "DRAFT",
    approvedAt: null,
    dataFinalizationState: input.dataFinalizationState,
    snapshot: payload,
    createdAt: input.nowIso,
  };
}

/** Support/admin mutation of approved snapshots is forbidden. */
export function updateApprovedSnapshot(): never {
  throw new Error("approved result snapshots are immutable; no support/admin edit path");
}
