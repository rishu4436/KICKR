# Contests (Phase 3)

Phase 3 is the contest engine before real money. It does not transfer USDC, create an escrow, confirm a deposit, settle, or pay a winner.

USDC amounts are integer base units. 5 USDC = 5000000. Currency is `USDC`. Templates are not instances.

## Development templates

These rows are development config, not a production fee freeze. More tiers can be added later.

| Code | Type | Capacity | Fee (base units) |
| --- | --- | --- | --- |
| H2H-5 | HEAD_TO_HEAD | 2 | 5000000 |
| H2H-10 | HEAD_TO_HEAD | 2 | 10000000 |
| H2H-20 | HEAD_TO_HEAD | 2 | 20000000 |
| H2H-50 | HEAD_TO_HEAD | 2 | 50000000 |
| GRAND-5 | GRAND_LEAGUE | 1000 | 5000000 |
| WTA-20 | WINNER_TAKES_ALL | 10 | 20000000 |

The seeded fee policy is 1000 bps and is labelled DEV. TODO: production fee bps are unspecified. Payout policies are frozen shapes with no calculation.

## Rooms

H2H keeps exactly one `OPEN` or `PARTIALLY_FILLED` instance per match and template. The partial unique index `contests_h2h_one_joinable_uidx` enforces that. When the room fills, it becomes `FULL`, leaves discovery, and the factory inserts the next room at 0/capacity in the same transaction. Grand League and Winner-Takes-All are one instance per match and template (`contests_single_instance_uidx`). They do not spawn sub-contests.

`rules_snapshot` is copied at creation (template version, fee, capacity, type, payout policy version, fee policy version, DEV_V1 scoring ruleset version, match id, kickoff lock time). A later template edit does not change it. The database trigger rejects snapshot updates. There is no application update path.

## Seats and quotes

`POST /contests/:id/reservations` authenticates the wallet, checks the team version, and allocates a seat with a conditional update inside a transaction. The entry status is `PENDING`. `CONFIRMED` exists for Phase 4 and is not set. A pending quote is not a paid seat. The quote carries an escrow placeholder with `reference: null`. That is not an escrow address.

`ENTRY_CONFIRMED` remains an audit constant and is not emitted. No financial event is written as if money moved.

Expired reservations cannot be confirmed. TODO: whether expiry releases the seat is unspecified, so Phase 3 does not free it.

`max_entries_per_match`, `max_entries_per_contest`, and `max_exposure_per_match` default to unset. Duplicate wallet in one contest is still rejected. Do not treat the unset knobs as a numeric cap.

## Lock

`LocalContestLockScheduler` is an in-process interface. It is not a distributed production scheduler. When it runs, joinable contests for a due match move to `LOCKED` through the shared state machine, including `OPEN → LOCKED`. Teams that already hold a seat are frozen. Late XI edits fail on the server.

`REFUNDED` still has no inbound edge. `VOID` edges exist only as exceptional non-financial closures and Phase 3 does not call them. Neither moves USDC.

## Cache

Discovery may be cached at `kickr:<env>:contestmatch:<matchId>`. Postgres is authoritative. If Redis is down, reads use the database. Order is database state, then audit and the contest outbox, then cache. Redis is not a source for payments, confirmed entries, escrow, settlement, or winners.

## API

- `GET /matches/:id/contests`
- `GET /contests/:id`
- `POST /contests/:id/reservations`
- `GET /reservations/:id`

Estimated prize pool is `filled_count * entry_fee_base_units`, labelled estimated, and is not funded money.
