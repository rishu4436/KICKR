# KICKR

Solana-native fantasy football contest platform. This repository is **Phase 1 only**: the software foundation for accounts, sessions, RBAC, and audit.

The escrow program does **not** exist in Phase 1. There is no USDC transfer, sports feed, scoring engine, contest factory, settlement worker, or payout flow.

Postgres is authoritative for accounts, sessions, RBAC assignments, and the audit log. Redis is a non-authoritative cache. Later, a Solana escrow program will be authoritative for USDC movement, and a sports provider will be authoritative for match events. Redis will never be authoritative for money.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

See `ARCHITECTURE.md`, `SECURITY.md`, `RBAC.md`, `AUDIT.md`, and `DEVELOPMENT.md`.


Phase 2 adds the football slice: match list, squad, and XI builder, plus a development-only scoring ruleset. It does not add contests or USDC. See `FOOTBALL.md`. Squad credits are not USDC. The escrow program still does not exist.
