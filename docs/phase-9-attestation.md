# Phase 9 — Independent result attestation boundary

## Purpose

KICKR already computes fantasy scores and settlement roots from its own stores. Phase 9 introduces a **provider-neutral ResultAttestation** and a **fail-closed settlement gate** so an independent attestor must cryptographically vouch for the finalized snapshot and result hash before economic approval / Merkle preparation.

This does **not** claim Sportmonks (or any sports feed) signs results unless its real API does. Assume it does not. The attestor is a configured Ed25519 identity, not “the oracle is decentralized.”

## Before (Phase 8 trust boundary)

Exact path:

1. **Sports provider** — `sports/sportmonks-provider.ts` / `sports/local-dev-provider.ts` via `sports/factory.ts`
2. **Normalized match events** — `sports/normalize.ts` → `live/pipeline.ts` (`acceptNormalized`) → `football` event store
3. **Fantasy scoring** — `domain/scoring/engine.ts` + `domain/scoring/dev-v1.ts` via `live/pipeline.ts` (`recomputeMatch`)
4. **Final score snapshot** — `live/snapshot.ts` (`buildDraftSnapshot` → `approve`) → APPROVED `match_score_snapshots`
5. **Result calculation / review / approval** — `settlement/orchestrator.ts` (`calculateFromApprovedSnapshots`) → `settlement/service.ts` (`calculate` / `review` / `approve`) via `api/settlement.ts` and `api/ops.ts`
6. **Settlement root** — `settlement/service.ts` (`prepare`) builds Merkle root + `settlement_hash`
7. **Solana settlement** — off-chain plan + on-chain `commit_settlement` (program crate unchanged); claims via merkle proof

**Where KICKR was the trusted authority:** from APPROVED snapshots through `RESULT_APPROVED` / `SETTLEMENT_PREPARED`. A scoring operator + reviewer (RBAC) could advance a result to a Merkle root with **no independent cryptographic attestation** of the snapshot/result binding. The program still gates USDC; the backend never held vault custody — but **result content** was KICKR-trusted.

Key refs: `settlement/from-snapshots.ts`, `settlement/service.ts` (`calculate`, `approve`, `prepare`), `settlement/approval-guard.ts`, `api/settlement.ts`.

## After (Phase 9 trust boundary)

Same ingest → scoring → APPROVED snapshot path. **New boundary before settlement advancement:**

- A `ResultAttestation` must exist for `(contest_id, result_hash)`.
- Ed25519 signature must verify against the **approved attestor registry** for the current env (`attestation/registry.ts`, `attestation/verify.ts`).
- Claims must match: `match_id`, `contest_id`, scoring ruleset id/version, `finalized_snapshot_hash` (recomputed from current APPROVED snapshots), and `result_hash` (settlement payload hash).
- Replay / substitution rejected (`attestation_id` uniqueness, `bound_settlement_id`).
- Stale rejected if score snapshots changed after attestation (`ATTESTATION_STALE`).
- `LOCAL_DEV` attestor: tests/dev only; **never** accepted in production (config load + verifier + gate).
- Production with no non-`LOCAL_DEV` attestor: **fail closed** at config load and at the gate.
- Backend **does not** sign attestations in production. No attestor private keys in the repo.
- Ops shows Verified / Missing / Invalid / Stale (`ops/read-model.ts`); **no** endpoint can mark an attestation valid.

Gate entrypoints: `settlement/service.ts` (`approve`, `prepare`) via `attestation/gate.ts` (`assertAllowsAdvancement`).

## Attestation format

Fields: `version`, `attestationId`, `matchId`, `contestId`, `scoringRulesetId`, `scoringRulesetVersion`, `providerSource`, `finalizedSnapshotHash`, `resultHash`, `issuedAt`, `attestorId`, `signature`, `verificationStatus`, `boundSettlementId`.

Canonical serialization: sorted-key JSON (`attestation/canonical.ts`) with domain prefix `KICKR_RESULT_ATTESTATION_V1\n` then SHA-256 hex. Signature: Ed25519 detached over the UTF-8 hex hash string (`tweetnacl`), wire-encoded base58 (hex accepted on verify).

Snapshot set hash: domain `KICKR_FINALIZED_SNAPSHOTS_V1` over sorted APPROVED snapshot rows.

## Verification rules (summary)

| Check | Error code |
|---|---|
| Empty registry | `ATTESTOR_REGISTRY_EMPTY` |
| Missing attestation | `ATTESTATION_MISSING` |
| Bad signature | `ATTESTATION_SIGNATURE_INVALID` |
| Unapproved attestor | `ATTESTOR_UNAPPROVED` |
| LOCAL_DEV in production | `LOCAL_DEV_ATTESTOR_FORBIDDEN` |
| Match / contest / ruleset mismatch | `ATTESTATION_*_MISMATCH` |
| Result hash mismatch | `ATTESTATION_RESULT_HASH_MISMATCH` |
| Snapshot changed | `ATTESTATION_STALE` |
| Reuse across settlements | `ATTESTATION_REPLAY` |
| Scoring not FINAL | `MATCH_NOT_READY` / snapshot errors |

Audit: `ATTESTATION_ACCEPTED` / `ATTESTATION_REJECTED` (append-only).

## Non-goals (unchanged)

- Escrow program crate unchanged
- Fee remains DEV **1000 bps**
- `RUN_SETTLEMENT` granted to nobody
- No backend USDC custody / signer / auto-settlement
- No production paid contests / India paid-entry
- Phase 10 not started
