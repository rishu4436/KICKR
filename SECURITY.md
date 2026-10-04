# Security

## Authority

Postgres is authoritative for accounts, sessions, RBAC assignments, reservations, entries, and audit. Redis is not authoritative for financial state. Phase 4 adds a devnet deposit program. Solana is authoritative for the deposit and the on-chain capacity counter. The program is not audited.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

The contest vault has no private key. Init authority can create config and contests and cannot withdraw. Do not add a backend key that can arbitrarily move the pot.

## Where authentication happens

`AuthService` in `auth/service.ts`, called by `api/server.ts`.

1. The wallet is a Solana public key (base58, 32 bytes). There is no password.
2. `POST /v1/auth/nonce` stores a random 32-byte nonce, bound to that wallet and `AUTH_DOMAIN`, with an expiry.
3. The client signs the exact message. The message contains the domain, wallet, nonce, and expiry.
4. `POST /v1/auth/login` checks domain binding, wallet binding, exact message match, expiry, and single use, then verifies the ed25519 signature with tweetnacl against the wallet public key.
5. A bearer session is stored as a SHA-256 hash. The raw token is returned once.
6. An `ACCOUNT_LOGIN` audit event is appended.

Logout revokes that session and appends `ACCOUNT_LOGOUT`.

Private keys and seed phrases are not accepted and are not stored.

## Replay, expiry, domain

- Nonces are consumed once. A second login with the same nonce fails with `AUTH_NONCE_REUSED`.
- A nonce at or after `expires_at` fails with `AUTH_NONCE_EXPIRED` and is not consumed.
- The signed domain must equal `AUTH_DOMAIN` and the domain stored with the nonce. A mismatch fails with `AUTH_DOMAIN_MISMATCH` and does not consume the nonce.
- The wallet in the message, the wallet in the body, and the wallet the nonce was issued to must be the same public key that verifies the signature.
- Sessions past `expires_at` fail with `AUTH_SESSION_EXPIRED`.
- Revoked sessions fail with `AUTH_SESSION_REVOKED`.

## Where authorization happens

After a session is accepted, `rbac/authorize.ts` unions permissions from `account_roles` and `account_capability_grants`. Routes call that check. There is no permission that means "everything".

`INDEXER_CONFIRM_ENTRY` is not in the permission catalog and is not grantable to any human role. The Phase 4 indexer confirms in process after finalized verification. Support cannot call that path.

No permission can move escrow. `RUN_SCORING` does not touch escrow. `RUN_SETTLEMENT` is not granted to any human role.

## What no backend employee can do

- No role can move escrow funds. There is no `MOVE_ESCROW` permission.
- SUPPORT cannot administer, cannot read or modify the audit log, and cannot modify scores, winners, or money. SUPPORT is `READ_USER_HISTORY`, `WRITE_SUPPORT_NOTE`, and `READ_CONTEST` only.
- BACKEND_DEVELOPER and APP_DEVELOPER cannot `RUN_SETTLEMENT` or `REVIEW_RESULT`.
- UI_UX_DEVELOPER has `READ_SYSTEM` only.
- CEO_HEAD does not execute settlement and does not move escrow.
- REVIEWER is not a role. The capability grants `REVIEW_RESULT` only.

The matrix is in `RBAC.md`.

## Audit

Append-only in the API (`updateAuditEvent` / `deleteAuditEvent` always throw) and in Postgres (BEFORE UPDATE and BEFORE DELETE triggers, plus `REVOKE UPDATE, DELETE` from `PUBLIC`). There is no audit mutation route. Details are in `AUDIT.md`.

## Request handling

- zod validates auth input. Unknown fields are rejected (`.strict()`).
- Errors are typed (`AppError`). Responses never include stack traces. When `NODE_ENV=production`, unexpected errors return `Internal error` and do not echo the exception message.
- Every response gets `x-request-id` (accepted from the client only when it matches a short safe pattern, otherwise generated).
- Logs go through `redact` so keys that look like passwords, tokens, signatures, seeds, or connection URLs are not written in the clear. Request bodies are not logged.
- `Cache-Control: no-store` is set on API responses.
- An in-memory rate limiter can wrap the nonce and login routes. The numbers are infrastructure defaults. TODO: a product rate-limit policy is unspecified. This is not a contest rule.
- Sessions are bearer tokens, not cookies.

## Config

`loadConfig` separates public, server, and secret fields. `DATABASE_URL`, `REDIS_URL`, and `SOLANA_RPC_URL` are secrets. The public object is an allowlist and must not contain them. Missing `DATABASE_URL`, `REDIS_URL`, or `AUTH_DOMAIN` fails startup. Local `.env.example` values are placeholders, not production secrets.

## Safe deletion

- Accounts: `deleted_at`. The wallet stays unique. TODO: restore is unspecified.
- Sessions: `revoked_at`, not a hard delete.
- Nonces: not deleted by the application.
- Audit: no delete.
- Roles and permissions: reference data, no delete API.
- Role assignment has no HTTP writer in Phase 1.

## Phase 4 deposit checklist

Not an audit. Upgrade authority on a deploy is not a formal audit.

- No generic transfer, `withdraw_all`, `admin_transfer`, `arbitrary_transfer`, or sweep.
- `deposit` destination is the contest vault ATA. The user is the signer and the transfer authority. There is no arbitrary destination.
- No vault key. The contest PDA would be the only future spender, and this phase has no instruction that signs for it.
- Account, mint, and token-program substitution is constrained to the contest account's mint and token program.
- Duplicate depositor and replay fail because the receipt PDA already exists. The count does not increase and tokens do not move.
- The deposit count uses `checked_add`. Amounts are `u64` base units. Decimals come from the mint passed to `transfer_checked`.
- PDA seeds are fixed: `config`, `contest` + 16-byte id, `deposit` + contest PDA + wallet. The vault is an ATA, not a second PDA with the same seeds.
- Capacity and lock are enforced in the program from account state and `Clock`, not from the backend.
- The user account is `Signer`. A missing signature fails the transaction.
- The token CPI uses the token program account on the instruction. A substituted program fails the contest's token-program constraint.
- A stale quote fails indexer expiry against the reservation. The program itself enforces `lock_at`, not the quote expiry. Quote expiry is an off-chain confirmation rule.
- A click, a reservation, a signature alone, or a raw vault transfer is not `ENTRY_CONFIRMED`.
- `DEPOSIT_VERIFIED` and `ENTRY_CONFIRMED` are appended only after commitment `finalized`.
- No employee permission moves funds. There is no `ARBITRARY_ESCROW_TRANSFER` or `MANUAL_WITHDRAWAL`.

Refund is not implemented. Shipping a refund that can pick a recipient would let an operator drain valid contest funds.
