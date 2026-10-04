# Devnet deposit proof

Public record of one finalized Devnet deposit into `kickr_escrow`. No private key, seed, or session token is in this file. This is not a mainnet transaction and it does not settle or pay out.

## Network

- Cluster: Devnet
- RPC used: `https://solana-devnet.api.onfinality.io/public`
- Genesis checked earlier: `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`
- Live Devnet end-to-end stays a manual release gate. CI does not call this RPC.

## Program and config

- Program id: `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`
- Config PDA: `J87z2ui9vP62U6gjGDiK23QdxVhr4j2FLwcRpzyQKb5y`
- USDC mint: `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` (Circle Solana Devnet USDC, 6 decimals)
- Token program: `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`

## Contest

- Contest id: `2ee3b8b1-cb75-426e-a2d0-9c36d734d9f8`
- Template: H2H-5, capacity 2, fee `5000000` base units
- Lock: `2026-10-10T15:00:00.000Z`
- Contest PDA: `DEQHAiMiKeVQdWzvxVjcPaaaMExiUpcguKMHJzGk2Ukb`
- Vault: `3HpRkESYi5PY4hm8CnumNN3R2jdWYcCHV37eSZ5suVex`

## Deposit

- Wallet (public): `AtWCqPeRhHtdxLiA9B3QpyR2uLzbJTVVuLgDwVCbCx2S`
- USDC of that mint before the deposit: `20000000` base units (20 USDC)
- Reservation id: `0930f696-4e17-4df2-ad0b-9ae9f9d846ef`
- Entry id: `b8dd6431-6f3d-4ecc-9a3c-dd604c1eb8ff`
- Team version id: `37e443a3-0250-4c73-9c71-a3ecda17ead5`
- The reservation and entry were `PENDING` before the indexer ran.
- Deposit receipt: `8JcojREV8BHFWwCevmbAh2AMcG5Ziipz1FG7RB9CcFBb`
- Signature: `21AdKSSrUuAhe3kugDH4A3NwZAVyRmTH5EZZ1VMPxcX74ceiKvPdUH9jP4JaG57VfrrKfrgrHHsES15aC8GjPjBe`
- Slot: `507205308`
- Finality: finalized, `meta.err` null
- Block time: `2026-10-04 07:37:33 IST`
- Explorer: https://explorer.solana.com/tx/21AdKSSrUuAhe3kugDH4A3NwZAVyRmTH5EZZ1VMPxcX74ceiKvPdUH9jP4JaG57VfrrKfrgrHHsES15aC8GjPjBe?cluster=devnet

The transaction invokes `kickr_escrow` `deposit`, not a raw token transfer. The depositor, mint, amount `5000000`, contest PDA, vault, and receipt match the reservation. The vault balance of that mint moved from `0` to `5000000`. The payer's balance of that mint moved from `20000000` to `15000000`.

## Indexer and seats

The real `DepositIndexer` read the transaction at commitment `finalized` and wrote the entry. First pass: `CONFIRMED` (not idempotent). Second pass: `CONFIRMED` (idempotent). Audit rows `DEPOSIT_VERIFIED` and `ENTRY_CONFIRMED` exist for entry `b8dd6431-6f3d-4ecc-9a3c-dd604c1eb8ff`. No SQL update was used to set the status or the counts.

`GET /reservations/0930f696-4e17-4df2-ad0b-9ae9f9d846ef` then showed the entry `CONFIRMED` with that signature. `GET /contests/2ee3b8b1-cb75-426e-a2d0-9c36d734d9f8` showed `PARTIALLY_FILLED`, filled `1`, remaining `1`, capacity `2`. `confirmed_count` is `1`. One seat does not fill a 2-seat H2H, so the factory did not open another H2H-5. No second wallet was used.

## Invalid cases

A deposit instruction with amount `1` instead of `5000000` was simulated and not submitted. The program returned `WrongAmount` (custom error `6003`) from `deposit.rs`. It did not confirm an entry.

A raw USDC transfer to the vault was not sent. There is no refund instruction in this phase, so that transfer would strand tokens. It was not used as a test.

## Not in this phase

No settlement, payout, claim, mainnet, or withdrawal.
