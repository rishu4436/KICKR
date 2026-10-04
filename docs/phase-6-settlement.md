# Phase 6 — Settlement, claims, and refunds

## Architecture rule

The backend may calculate and approve results. It is **never** the source of truth for USDC and has **no** arbitrary authority to move funds.

- The Solana program (`DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`) remains the vault authority.
- No backend private key, server wallet, hot wallet, or database balance ledger is treated as USDC truth.
- No instruction lets an admin or backend transfer arbitrary amounts to arbitrary wallets.
- Vault spends exist only in `claim_payout` and `claim_refund`, gated by commitment / deposit receipt checks.

## Lifecycle

Match / settlement machine:

`DATA_FINALIZING → FINAL → RESULT_CALCULATED → RESULT_REVIEWED → RESULT_APPROVED → SETTLEMENT_APPROVED → SETTLEMENT_PREPARED → SETTLEMENT_SUBMITTED → SETTLEMENT_CONFIRMED`

Failure path: `SETTLEMENT_SUBMITTED → SETTLEMENT_FAILED → SETTLEMENT_SUBMITTED` (retry).

**SUBMITTED ≠ CONFIRMED.** A failed RPC or dropped tx must never mark funds settled. Confirm only after independent verification of a finalized Solana transaction (signature, program instruction, contest, settlement version, result hash, merkle root, amounts) — same philosophy as Phase 4.1 deposits. Reconcile chain state before assuming failure. Retry must not create a second settlement or payout.

Void path (before settlement): contest → `VOIDED` on-chain → `claim_refund` per confirmed deposit. Refund after settlement fails.

## Immutable result snapshot

Recompute from the append-only event path and contest entry **`team_version_id` exactly** (Phase 5.1). Frozen contest ruleset. Captain 2× / vice 1.5× (DEV_V1) applied once. Deterministic rankings.

Phase 5.1 `match_score_snapshots` (DRAFT → APPROVED) remains the score snapshot boundary. Phase 6 extends that into `contest_settlements` + `settlement_result_rows` with payout fields. Approved economic fields are immutable (DB triggers + service guards). Mistakes before approval → new calculation / settlement version. After approval, no silent mutation.

### Snapshot fields

contest_id, match_id, ruleset id/version, entry_id, team_version_id, XI, captain, vice, base_score, final_score, rank, result status, payout amount, destination wallet, contest rules, entry fee, seat count, confirmed entries, fee policy, payout policy, settlement version, result_hash, merkle_root, settlement_hash, approved_at, approved_by.

## Result hash

Canonical deterministic JSON (sorted keys) → SHA-256 hex. Same logical state → same hash. Stored with `settlement_version`, `created_at`, `approved_at`, `approved_by`. The hash binds the off-chain result to the on-chain `commit_settlement` instruction.

## Tie policy (explicit)

**`entry_id_asc`**: when final milli-points are equal, lower `entry_id` (UUID string lexicographic order) receives the better (lower) rank. Ranks are unique. Documented and tested. Not a silent default.

## Payout math

From **confirmed** entry fees + **frozen** fee policy + **frozen** payout policy + approved ranking. Integer base units only (6 decimals).

- Fee: Phase 3 DEV **1000 bps**, labelled DEV.
- H2H / WTA (`winner_takes_prize_pool`): rank 1 receives 100% of prize pool after fees.
- Grand League (`rank_bps`): frozen schedule in payout policy v2 — ranks 1–4 at 4000/3000/2000/1000 bps of prize pool (DEV schedule, not production).
- Invariant: `sum(net payouts) + fees == contest pot` (no unexplained remainder; unallocated Grand League remainder accrues to fee).

Payout policy v2 rows are seeded in migration `007_phase6_settlement.sql`. Templates point at v2 for new contests. Existing contests keep whatever was frozen in `rules_snapshot`.

## Solana instructions

Preserved: `initialize_config`, `initialize_contest`, `deposit`, `lock_contest`.

Added:

1. **`commit_settlement(version, result_hash, merkle_root, total_payout, fee)`** — init authority only. Creates settlement PDA. Marks contest `SETTLED`. Does **not** transfer tokens.
2. **`claim_payout(version, entry_id, amount, proof)`** — claimant signs. Verifies settlement active, merkle proof, claimant, amount; creates claim PDA (second claim fails); `transfer_checked` from vault ATA.
3. **`void_contest`** — init authority; before settlement only.
4. **`claim_refund`** — depositor on voided contest; replay-safe refund PDA; fails after settlement.

Rejected: double settlement (same version PDA), wrong proof/wallet/amount/mint/vault, replayed claim, admin withdraw/sweep/arbitrary transfer. Mainnet USDC mint remains rejected by existing config discipline; Devnet mint stays configurable.

Leaf: `sha256("KICKR_PAYOUT_V1" || entry_id_16 || amount_u64_le || claimant_32)`.
Parent: sorted-pair `sha256(min||max)`.

## Claims and replay

- Claim PDA seeds: `["claim", contest, version_le, entry_id]`.
- Concurrent claims for one entry: exactly one succeeds (PDA init).
- Concurrent settlement commits for one version: exactly one succeeds.
- Same signature twice → idempotent confirm off-chain; no second payout.

## RBAC

| Permission | Who |
|---|---|
| `RUN_SCORING` | `BACKEND_DEVELOPER` — calculate / inspect; must not auto-approve |
| `REVIEW_RESULT` | `REVIEWER` capability only — review / approve / reject |
| `RUN_SETTLEMENT` | **Granted to nobody** — prepare / reconcile APIs require it for ops wiring; not on any human role |
| Indexer-style confirm | Not grantable to humans (same philosophy as `INDEXER_CONFIRM_ENTRY`) |

RBAC is not a substitute for on-chain checks. No API accepts an arbitrary winner wallet and amount.

## Reconciliation

`decideSettlementCommit` / `decideClaim` mirror Phase 4.1 deposit verification: finalized commitment, program id, contest, hashes, amounts, mint, vault, destination. Failed observed tx may mark `SETTLEMENT_FAILED` only after that observation — never on bare RPC timeout.

## UI stages

After finalization: **Match Final → Result Processing → Results Verified → Prize Available → Claim Prize**.

- Winner: rank, score, prize USDC, claim affordance.
- Non-winner: prize 0.
- Pending copy while unconfirmed.
- **Claimed** only after verified tx + explorer link. Never “paid” on click. Never fake a signature.

## Sports events → user wallet

```
Sportmonks/local events
  → append-only match_events
  → DEV_V1 recompute (exact team_version_id)
  → APPROVED score snapshot (Phase 5.1)
  → result calculation + result_hash
  → REVIEWER approve (immutable)
  → merkle prepare (settlement_hash)
  → init_authority signs commit_settlement (offline / ops; not backend hot wallet)
  → indexer reconciles finalized commit → SETTLEMENT_CONFIRMED
  → user signs claim_payout with merkle proof
  → program transfers USDC from contest vault ATA to claimant
```

## Devnet proof

Program id: `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`  
RPC: `https://solana-devnet.api.onfinality.io/public`  
USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`  
Payer / upgrade authority: `AtWCqPeRhHtdxLiA9B3QpyR2uLzbJTVVuLgDwVCbCx2S` (key only in `/tmp/kickr-devnet-payer.json`, never committed).

Phase 6 adds instructions, so Devnet requires a **program upgrade** with that upgrade authority. If the E2E script ran successfully, real signatures are listed below. If not, this section states why.

### Devnet settlement / claim status

**Ran successfully on Devnet** after upgrading program id `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`.

| Step | Signature |
|---|---|
| Program upgrade | `2xJUJuja7NVBmvNtxz3YLfJ1rDyJ9g3535wAaiisqASuFzWF7DAX62GcWkquPbdYZemAArfJmV6xhxLsBnpkSdtq` |
| initialize_contest | `o96zubWovDTwLjFEgyrJtJZZh14oG7g7RmZxjRNRSnh2JP3zRw7TYvK8WBTa44NbugLtDitE3N5zSiMJLTcWr57` |
| deposit (alice) | `r7CKRcPVHkcFdyH5U34aoPFf12y8pMV7NQ7oBcK9KeiyZBZWT635UNuaPsw1R2fKePdieteWrmgbQLfvu1XJm8u` |
| deposit (bob) | `3jQr1cNJDHmZGH6MMaJqibNAHTZaBtbKNSkCL7oLZkfEFTKZV2fQCCsJZJUzTAZoz7v4NRhg4Kkgv8re6MY3qtFk` |
| lock_contest | `39Jb7N3iK6JW3RAGVfpSHH5izpDVgsaX3A6Eggq9gmqbn4ob1KN2JSYrmPtU3aFeeR76wqY1FDdqomCdqteo1nTP` |
| **commit_settlement** | `4LshyQp4kPLH7Kavq53caCCMcMYagWU1qY5qR8uEBjFzv9tTXGhFQGaMyHKcwS8rVR7Je3qwdniDsS8afm1zmoAG` |
| **claim_payout** | `4xyxz6muE9SDQYuj2WoVUy9umh15rCWRK5niuGGG31MX3JHxZVy1xnKLRnLLCZ2FSvUuYnuky8Zr7ErjnaxhMFUw` |

Observed:

- Contest PDA: `8Z2qH64FatTjNUczJXjH1vmQgBeWT9q9zP2Vjhp8bJ1X`
- Vault: `8vUCRAgKgEWWoMvK1oZ3wx2imRPzwRDX7MgHWechWnKw`
- Settlement PDA: `TyhQW8mnVSUvCvXWkexWJSXXME6Gr8XN1VcVpnhEazp`
- result_hash (Devnet fixture): `1111111111111111111111111111111111111111111111111111111111111111`
- merkle_root: `62aa2891b219e3841748e22a25daccabb8a4accecf00cc28bc9b61dcd9d25878`
- Vault before claim: `10000000` base units; after claim: `1000000` (fee retained in vault; no admin withdraw)
- Second claim for the same entry: **failed** (replay-safe)

RPC: `https://solana-devnet.api.onfinality.io/public` (official `api.devnet.solana.com` unreachable from this box).

## Test hash examples (labelled test, not Devnet)

- result_hash (test): `b587746ebac4f54c8e9ff7e8be36ebbbc25d153a817953c1ae77e0a02f979568`
- settlement_hash (test): `8231e5acd41aa5cd54bbc939473eeeb2c5f29c943e952ec278cc5ef5e2a87d87`

## Phase 6.1 End-to-End Proof

Goal: football events → final scoring → APPROVED `match_score_snapshot` → contest ranking → payout → immutable manifest → merkle → Solana `commit_settlement` → user `claim_payout` → verified USDC.

Program id: `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`  
`RUN_SETTLEMENT` remains granted to **nobody** (not Backend, not Support). Reviewer boundary unchanged. No second scoring engine. No `TEST_FIXTURE` settlement branch. No hardcoded Devnet winner/payout/result hash. All-ones `1111…1111` is **not** used as the Phase 6.1 primary proof (Phase 6 used it only as a labelled fixture).

### Hash classes (do not conflate)

| Class | Meaning |
|---|---|
| Unit-test hashes | Deterministic hashes inside `tests/settlement*.test.ts` / LiteSVM fixtures — **not** production results |
| Local fixture hashes | In-memory Phase 6.1 harness (`tests/phase6_1_e2e.test.ts`, `scripts/phase6_1-devnet-e2e.ts` local stage) through real scoring → APPROVED snapshots → settlement — **not** on-chain |
| Devnet hashes | On-chain commitment from the Phase 6.1 script after real deposits — primary Phase 6.1 chain proof |

### Local fixture (application tests)

Harness: 2 clubs, 22+ players, 1 match, XI + captain/vice, contest, confirmed entries, match events, APPROVED score snapshot, payout, merkle prepare. Winner emerges from scoring (not injected). Settlement uses `contest_entries.team_version_id` exactly. Captain/vice multipliers applied once in scoring. Tie-break remains `entry_id_asc`. Payouts from **frozen** contest `rulesSnapshot` (mutable template cannot alter settled payout). Unapproved/DRAFT snapshots refuse settlement prep.

Example local fixture hashes from a successful harness run (labelled local, not Devnet):

- local fixture result_hash: `4f69ed35e7ad5ecd855aef2fe70f9164f38cc86346430b38a70b6bfe5c4d314d`
- local fixture merkle_root: `e6f2b06661d24e2b2d89b0e0bef7f6c2d8f6afaed7040695aa902097a2a67563`
- local fixture settlement_hash: `64d79d8377464b153dfb3ce10334632675c8a58e29329efd4535a84d9ab23b7c`

### Devnet demonstration (fresh, Phase 6.1)

RPC: `https://solana-devnet.api.onfinality.io/public`  
USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`  
Payer (public): `AtWCqPeRhHtdxLiA9B3QpyR2uLzbJTVVuLgDwVCbCx2S` (secret only in `/tmp/kickr-devnet-payer.json`, never committed).

Scores/ranks came from the real Phase 6.1 scoring fixture. On-chain entry fee was scaled to available Devnet USDC (`2000000` base units × 2 seats) so deposits could complete; destinations remapped to the payer for the claim leaf. Result hash is **not** all-ones.

| Field | Value |
|---|---|
| Contest PDA | `6JfYgriQ1YqNnUgMorqvVHYnEvfUcuwtPciYc9LLoF3a` |
| Vault | `AkpoZHgDYLh1eJd772WhzYV2YMX16yrDDkepatggBRhb` |
| Settlement PDA | `GaVWL5teJiKeZdupKDhmMxyzicYS7Bb5oRvLyjBFSMoM` |
| result_hash | `3a42cd4000de85b571d6eb1355553b4328de7a4af74405a5d3e94abc81101c91` |
| merkle_root | `42371c23ee96d546796c78d6c174f00344f9924011b3716fdff2f736dc353a70` |
| settlement_hash | `a5147cdd351d855dfd886a521a2b3ebcf82b6ea0b09260289956faca4f32d8b1` |
| settlement tx (`commit_settlement`) | `SoCKK59GGxTpxVLAAwmuRs4CR9thKrPXYd4uvs8ZQaziVG2g34F4eTaaHrrn1noXViE8y4MtebJQnzC3uGDbLDt` |
| claim tx (`claim_payout`) | `2CNjNBrvbRoVa8hxzoQW6SBDRZk2N6FkWP2VDG3MoBaTFePVipGXpYLZBwNJxVBh4Cbi3ioKDstLASw782Xhqfvv` |
| Vault before / after | `4000000` → `400000` |
| Claimed amount | `3600000` |
| Fee retained in vault | `400000` |
| Winner entry | `74f2db93-8137-4527-bdc8-5f3a4e5c8d31` |
| Winner score / rank / payout | `19500` milli-points / rank `1` / `3600000` base units |
| Destination | `AtWCqPeRhHtdxLiA9B3QpyR2uLzbJTVVuLgDwVCbCx2S` |

Second claim: client/simulation blocked before a broadcast signature (`secondClaimBlockedBeforeSubmit: true`). No fabricated failed signature. Program-level replay protection remains covered by LiteSVM `settlement.rs`.

### API / UI (Phase 6.1)

- `GET /contests/:contestId/my-result` — caller entry only (contest, entry, team version, XI, captain, vice, scores, rank, prize, settlement/claim status, tx signature when verified).
- Claim flow uses authorized backend proof for the authenticated entry; amounts/proof come from immutable approved settlement. Claim UI states: idle / claimable / wallet_signing / submitted / confirming / confirmed / failed / already_claimed. Never “Paid” before independent verification; never `setClaimed(true)` on wallet submit.
