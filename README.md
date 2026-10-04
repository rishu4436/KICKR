# KICKR

Solana-native fantasy football contest platform. This tree includes Phases 1–5 foundations through live scoring. Settlement and winner payouts are not implemented.

Phase 5 adds Sportmonks live ingestion, append-only events, DEV_V1 live scores, Redis cache, SSE, and diagnostics. There is still no settlement worker or payout flow. See `docs/LIVE_SCORING.md`.

Postgres is authoritative for accounts, sessions, RBAC assignments, and the audit log. Redis is a non-authoritative cache. Later, a Solana escrow program will be authoritative for USDC movement, and a sports provider will be authoritative for match events. Redis will never be authoritative for money.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

See `ARCHITECTURE.md`, `SECURITY.md`, `RBAC.md`, `AUDIT.md`, and `DEVELOPMENT.md`.


Phase 2 adds the football slice: match list, squad, and XI builder, plus a development-only scoring ruleset. It does not add contests or USDC. See `FOOTBALL.md`. Squad credits are not USDC. The escrow program still does not exist.

Phase 3 adds contest templates, instances, rotating H2H rooms, reservations, and the marketplace. Join creates a pending quote only. It does not move USDC or confirm a seat. See `CONTESTS.md`.

Phase 4 adds devnet deposits into `escrow/` (`kickr_escrow`). The user wallet signs `deposit`. The indexer sets `ENTRY_CONFIRMED` only after a finalized match. There is no settlement, prize claim, treasury transfer, or mainnet mint. See `DEPOSIT_FLOW.md`, `ESCROW.md`, `SOLANA.md`, and `DEVNET.md`.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.
