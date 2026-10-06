import { AppError } from "../shared/errors.js";
import type { AttestationStore, ResultAttestation } from "./types.js";

export class InMemoryAttestationStore implements AttestationStore {
  private readonly rows = new Map<string, ResultAttestation>();

  async insert(row: ResultAttestation): Promise<void> {
    if (this.rows.has(row.attestationId)) {
      throw new AppError("ATTESTATION_DUPLICATE", 409, "Attestation id already exists");
    }
    this.rows.set(row.attestationId, structuredClone(row));
  }

  async update(row: ResultAttestation): Promise<void> {
    if (!this.rows.has(row.attestationId)) {
      throw new AppError("NOT_FOUND", 404, "Attestation not found");
    }
    this.rows.set(row.attestationId, structuredClone(row));
  }

  async getById(attestationId: string): Promise<ResultAttestation | null> {
    const row = this.rows.get(attestationId);
    return row ? structuredClone(row) : null;
  }

  async findForContestResult(contestId: string, resultHash: string): Promise<ResultAttestation | null> {
    const row = [...this.rows.values()].find(
      (item) => item.contestId === contestId && item.resultHash === resultHash,
    );
    return row ? structuredClone(row) : null;
  }

  async listForContest(contestId: string): Promise<ResultAttestation[]> {
    return [...this.rows.values()]
      .filter((row) => row.contestId === contestId)
      .map((row) => structuredClone(row))
      .sort((a, b) => (a.issuedAt < b.issuedAt ? -1 : a.issuedAt > b.issuedAt ? 1 : 0));
  }
}
