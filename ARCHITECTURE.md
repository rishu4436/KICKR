# Architecture

Phase 1 is a production-shaped foundation so later services do not have to restructure identity, authorization, or audit. It is not the contest product.

## What is authoritative now

Postgres is the source of truth for:

- accounts (one Solana wallet, one account, no password)
- login nonces
- sessions (token hash only)
- roles, permissions, role assignments, and the REVIEWER capability grant
- audit events

The application permission map in `rbac/matrix.ts` is authoritative for what a role or capability allows. The database stores who holds a role or capability. It does not store a second, divergent grant matrix.

## What will be authoritative later

- A Solana escrow program will be authoritative for USDC movement. **That program does not exist in Phase 1.** No backend private key that can arbitrarily move a contest pot is configured, and none should be added.
- A sports provider will later be authoritative for match events. Phase 1 does not call one. `SPORTS_DATA_PROVIDER` is a placeholder.
- Redis will never be authoritative for money, sessions, RBAC, or audit. It is a cache with versioned JSON values and keys of the form `kickr:<env>:<domain>:<id>`.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

Future USDC amounts, if a later migration adds them, must be `bigint` integer base units. Phase 1 has no money columns. Floating point is not used for money.

## Where requests are decided

1. `api/server.ts` validates input with zod, assigns a correlation id, and optionally applies the auth rate-limit abstraction.
2. Authentication is `auth/service.ts`: nonce, ed25519 signature, session. The HTTP layer does not trust a wallet string by itself.
3. Authorization is `rbac/authorize.ts`, after authentication, using role rows plus capability rows.
4. Login and logout append audit events. Other event names exist as constants only.

There is no raw status setter. `domain/state-machine.ts` exposes `isTransitionLegal` and `transition`. `transition` throws on an illegal edge.

## Layout

Directories sit at the repository root (not under `src/`) so the boundaries stay obvious:

| Path | Role |
| --- | --- |
| `app/` | Placeholder. No product UI. |
| `api/` | HTTP entrypoint. |
| `domain/` | State-machine infrastructure. |
| `db/` | SQL migrations, Postgres repositories, migration runner. |
| `auth/` | Wallet login and session rules. In-memory repositories are test doubles. |
| `rbac/` | Permission catalog and least-privilege matrix. |
| `audit/` | Append-only audit store and the update/delete refusal. |
| `redis/` | Cache client, key names, health check. |
| `config/` | Public, server, and secret config. |
| `workers/` | Named contracts only. No worker processes. |
| `shared/` | Errors, logging, ids, rate-limit interface. |
| `tests/` | Unit tests. They do not need live Postgres or Redis. |
| `migrations/` | SQL applied by `npm run db:migrate`. |

## Services that can split later

Only the API process has an entrypoint (`api/main.ts`). These can become separate deployables without replacing the tables above:

- API
- Indexer
- Scheduler
- Scoring worker
- Review tool
- Settlement worker
- Support console
- Monitoring

`workers/contracts.ts` names them. It does not implement them.

## Contest lifecycle

Known contest states: `OPEN`, `PENDING`, `CONFIRMED`, `LOCKED`, `IN_REVIEW`, `READY_FOR_SETTLEMENT`, `SETTLED`, `REFUNDED`.

Legal edges in Phase 1:

`OPEN → PENDING → CONFIRMED → LOCKED → IN_REVIEW → READY_FOR_SETTLEMENT → SETTLED`

`REFUNDED` is a known state with **no** legal inbound edge.

## TODO

- ACCOUNT, TEAM, MATCH, ENTRY, REVIEW, and SETTLEMENT states and transitions are unspecified.
- Which contest states may move to `REFUNDED` is unspecified. It is not allowed from every state.
- Whether any contest transition may be reversed is unspecified.
- Support-note storage is unspecified. `WRITE_SUPPORT_NOTE` exists; there is no note table.
- No audit event type was specified for RBAC changes, so Phase 1 has no RBAC mutation endpoint.
- Who may hold `RUN_SETTLEMENT` is unspecified. No human role has it.
- Whether REVIEWER also needs `READ_CONTEST` is unspecified. The capability grants `REVIEW_RESULT` only.
- Headcount numbers in the brief are not enforced.
- Account restore after soft-delete is unspecified. A deleted wallet cannot open a second account.
- Login-nonce retention and session retention are unspecified. The application does not delete those rows.
- Concurrent session policy is unspecified. Logout revokes only the presented session.
- Grouping `MANAGE_MATCH_CONFIG` and `MANAGE_CONTEST_CONFIG` as OPERATE rather than ADMINISTER is a classification choice, not an extra power. Confirm with product if those should move group.
- Auth rate-limit numbers are temporary infrastructure defaults, not a contest policy.
- Trusted-proxy handling for client IP is unspecified.
- Per-event audit metadata keys are unspecified beyond "metadata is a JSON object".


## Phase 2 football slice

Matches, squads, fantasy teams, and DEV_V1 scoring sit on the Phase 1 account, auth, and audit foundation. See `FOOTBALL.md`.

Postgres remains authoritative for these new tables. Redis is still not authoritative for money or for XI history. The escrow program still does not exist. Squad credits are not USDC.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

## Phase 3 contest engine

Templates, instances, atomic seats, and join quotes sit on the Phase 1 guard and the Phase 2 match and XI tables. See `CONTESTS.md`.

Postgres is authoritative for contests, reservations, entries, and the contest outbox. Redis discovery is a cache. Phase 3 does not transfer USDC or confirm an entry. `ENTRY_CONFIRMED` is not emitted.

The Phase 1 contest path remains legal. Phase 3 also allows `OPEN → PARTIALLY_FILLED → FULL → LOCKED → IN_PROGRESS → IN_REVIEW → READY_FOR_SETTLEMENT → SETTLED`, and `OPEN → LOCKED` when a match lock closes a joinable room. `REFUNDED` is still unreachable.
