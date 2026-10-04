# Escrow

Devnet deposit program `kickr_escrow` in `escrow/`. This is not an audit. Upgrade authority, if a deploy sets one, is not a formal audit.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

Phase 4 only adds deposits. The program has no settlement, claim, treasury fee, `withdraw_all`, `admin_transfer`, `arbitrary_transfer`, or sweep. No private key is the vault authority.

## Who can initialize

`initialize_config` stores the signer as `init_authority` plus the mint, token program, and mint decimals. There is no update instruction. `initialize_contest` requires that same signer (`has_one = init_authority`). After the contest account is created, entry fee, capacity, mint, token program, and vault are not writable by any instruction. The init authority cannot withdraw.

## Seeds

| Account | Seeds |
| --- | --- |
| config | `["config"]` |
| contest | `["contest", contest_id]` with `contest_id` 16 bytes |
| deposit receipt | `["deposit", contest_pda, depositor_wallet]` |
| vault | ATA of the contest PDA for the configured mint and token program. Not a program PDA. |

## deposit

The user is the signer. Accounts, in order: user wallet, user USDC ATA, mint, contest, vault, deposit receipt, token program, associated token program, system program.

The program checks the signer, token-account owner, mint, token program, joinable status, `now < lock_at`, `count < capacity`, `amount == entry_fee`, and that this wallet has no receipt yet. It then increments the count, writes the receipt, and CPIs `transfer_checked` for that exact amount. Any failure rolls the transaction back. No tokens move.

The receipt stores contest id, depositor, amount base units, mint, reservation nonce hash, team version id, created at, status, and bump. It is an account, not a log. `DepositRecorded` is also emitted.

## Refund

Not implemented. A refund of a valid deposit would drain the contest, and an operator refund cannot tell an unmatched deposit from a valid one without an instruction that can spend the vault. Unmatched successful deposits stay in the vault until a later instruction whose inputs are already the entry table and the approved snapshot. There is no manual escrow transfer.

## Token program

Accounts use Anchor `Interface` / `InterfaceAccount` for the token program, mint, and token accounts. `transfer_checked` passes the configured program id. Hackathon default is an SPL USDC-compatible mint, 6 decimals, devnet, from configuration. The mainnet USDC mint is refused by config.
