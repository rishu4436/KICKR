# Deposit flow

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

1. The API checks the team version and the contest, then writes a `PENDING` reservation, a `PENDING` entry, and a quote. That is not a seat.
2. The response includes a deposit plan when `USDC_MINT` is set: contest, fee, mint, contest id, team version, vault, network, and expiry. `payment` stays `PAYMENT COMING IN PHASE 4` until a later phase changes that label. The plan is not a payment.
3. The user wallet signs `deposit`. The frontend states are `RESERVING`, `AWAITING_WALLET`, `SUBMITTED`, `VERIFYING`, `CONFIRMED`, `FAILED`, and `EXPIRED`. "Transaction submitted" is not "Entry confirmed". Joined is not shown from a click.
4. `POST /reservations/:id/deposit-submission` stores the signature and appends `DEPOSIT_SUBMITTED`. It does not confirm.
5. The indexer loads the transaction at commitment `finalized` and matches contest, wallet, amount, mint, vault, deposit receipt, and reservation nonce. Only then does it write the entry to `CONFIRMED` in one database transaction and append `DEPOSIT_VERIFIED` and `ENTRY_CONFIRMED`.
6. A raw transfer to the vault, a pending signature, a reservation, or `labelledFixture: true` does not confirm. Mismatches append `DEPOSIT_REJECTED` and do not attach the deposit to someone else.

Support with `READ_CONTEST` can `GET /contests/:id/deposits`. `GET /deposits/health` requires `READ_SYSTEM` and returns pending reservations, pending entries, submitted deposits, rejections, verified deposits, and mismatches. It does not include credentials and it cannot confirm. RPC error and lag counters live on the indexer process. There is no `ARBITRARY_ESCROW_TRANSFER` or `MANUAL_WITHDRAWAL` permission. `INDEXER_CONFIRM_ENTRY` is still not grantable.

No employee action moves funds. The program never signs for the vault in this phase.
