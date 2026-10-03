# Security

## Authority

Postgres is authoritative for accounts, sessions, RBAC assignments, and audit. Redis is not authoritative for financial state. The Solana escrow program does **not** exist in Phase 1.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

Future escrow must never depend on a backend private key that can arbitrarily move the contest pot. Phase 1 does not define, load, or store such a key. Do not add one.

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

`INDEXER_CONFIRM_ENTRY` is not in the permission catalog and is not grantable to any human role. Entry confirmation is reserved for a future program/indexer path.

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
