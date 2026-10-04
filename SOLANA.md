# Solana

Cluster is configuration: `SOLANA_CLUSTER` is `devnet`, `localnet`, `localhost`, or `testnet`. Any value containing `mainnet` fails startup. `USDC_MINT` is blank or a mint you created. `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` is rejected. `USDC_DECIMALS` defaults to 6. `ESCROW_PROGRAM_ID` defaults to the id in `declare_id!`. `SOLANA_RPC_URL` stays a server secret and is not in public config.

Finality is the string `finalized`. `processed` and `confirmed` do not confirm an entry. The indexer calls `getTransaction` with `commitment: "finalized"`. Stored fields are signature, slot, block time when the RPC returns one, `amount_base_units`, mint, sender, vault, contest PDA, deposit receipt, and confirmation status. Amounts are integers.

Postgres is authoritative for reservations and entries. Solana is authoritative for the financial deposit and the on-chain capacity counter. `filled_count` still moves at reservation time, which is what Phase 3 rooms use. `confirmed_count` moves only after verification and does not increment `filled_count` again. When an H2H room already wrote `CONTEST_FILLED`, confirmation does not open a third room.

The canonical PDA helpers live in `solana/escrow.ts`: `deriveContestPda`, `deriveVaultAddress`, `deriveDepositReceipt`, `buildDepositTransaction`, `getContestEscrowState`. The API and the UI both import that module.

If the RPC throws, the indexer leaves the entry `PENDING`. It does not invent a custodial transfer. The same finalized signature processed twice confirms once. A database failure after the chain succeeded is retried; the second write is the confirmation. An unknown nonce is not attached to another entry. A chain confirmation does not replace `team_version_id`.

`cd escrow && anchor test --skip-deploy` runs the program tests on LiteSVM against the compiled `.so`. It does not keep a `solana-test-validator` process. GitHub Actions does not install Anchor; run that command locally.

LiteSVM 0.10 cannot load the default SBF v3 ELF (`InvalidAccountData`). `anchor test` rebuilds with `cargo-build-sbf --arch v0` before `cargo test`. That is a test-runner limit, not a second program.
