# Devnet

This phase is devnet only. Do not point `SOLANA_CLUSTER` at mainnet. Do not put a mainnet mint in `USDC_MINT`. Do not commit a keypair or seed phrase. `.env.example` is placeholders only.

Toolchain used for this tree: Solana CLI 4.3.0 (Agave), Anchor CLI 1.2.0, host Rust 1.89.0. `anchor test` uses LiteSVM 0.10 (`skip_local_validator = true`). It is not a long-running `solana-test-validator`. GitHub Actions does not install these tools.

LiteSVM 0.10 cannot load the default SBF v3 ELF (`InvalidAccountData`). `anchor test` rebuilds with `cargo-build-sbf --arch v0` before `cargo test`. That is a test-runner limit, not a second program.

## Build and test on a local validator (LiteSVM)

```bash
export PATH="$HOME/.cargo/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"
cd escrow
anchor build
anchor test --skip-deploy
```

`anchor test` runs `cargo test --manifest-path programs/kickr_escrow/Cargo.toml` against `target/deploy/kickr_escrow.so`.

## Deploy

The declared program id is `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`. The deploy keypair must stay outside git (`escrow/.gitignore` ignores `*-keypair.json`). A keypair whose public key matches that id is required. This repository does not contain one.

```bash
solana config set --url devnet
# Point the CLI at a throwaway key that is not in the repo. Do not paste the seed here.
solana airdrop 2
anchor build
solana program deploy escrow/target/deploy/kickr_escrow.so \
  --program-id /absolute/path/kickr_escrow-keypair.json
```

## Init, fund, deposit

Create a devnet mint. Do not use mainnet USDC.

```bash
spl-token create-token --decimals 6
# set USDC_MINT to that address and USDC_DECIMALS=6
spl-token create-account <MINT>
spl-token mint <MINT> 10
```

Initialize config and a contest with the init authority (the same wallet that will sign `initialize_config`). That wallet cannot withdraw. Then have the user wallet sign `deposit` for the exact fee before `lock_at`. Wait until `solana confirm <SIGNATURE> --commitment finalized`. The indexer may then set the entry to `CONFIRMED`. A signature that is only submitted is not a seat.

Explorer, after a real finalized signature exists:

`https://explorer.solana.com/tx/<SIGNATURE>?cluster=devnet`

## This machine

Program id in source: `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`. The first query returned null. A later deploy on Devnet is recorded below.

A throwaway payer was created only in `/tmp` (not in git). `solana airdrop 2` against `https://api.devnet.solana.com` failed: `error sending request for url (https://api.devnet.solana.com/)`. No devnet transaction was signed or broadcast. There is no vault address, no deposit signature, and no explorer link. Local LiteSVM tests are the proof that ran. This is not a fake devnet signature.

### Phase 4.1 retry (2026-10-04)

Live devnet end-to-end is a manual release gate. `.github/workflows/ci.yml` runs lint, typecheck, test, and build only. It does not call a public RPC and must not.

`https://api.devnet.solana.com` still fails from this host: DNS for that name is `198.18.0.1`, then TLS `unexpected eof while reading`. That is not a successful cluster query.

A documented public Devnet RPC did answer: `https://solana-devnet.api.onfinality.io/public`. `getGenesisHash` was `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG` (Devnet, not mainnet). `getVersion` / `solana cluster-version` reported solana-core 4.3.0. No mainnet RPC was used.

The throwaway payer `AtWCqPeRhHtdxLiA9B3QpyR2uLzbJTVVuLgDwVCbCx2S` later showed `5 SOL` on that RPC (5_000_000_000 lamports, confirmed). The key stayed in `/tmp` and was not committed. `solana program deploy` of `escrow/target/deploy/kickr_escrow.so` with the matching program keypair succeeded.

- Program id: `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`
- Deploy signature: `5xkY9Dzbk2e3dsiGGW7YmHtF8WbkohA6VgeyqaK1w9yN9kzvJt66smt2ABcRG1cYKyMJ53Hw3sN47t2GRrj9eo8v`
- Deploy slot: `507201818`, finalized, `meta.err` null. Account is executable, owner `BPFLoaderUpgradeab1e11111111111111111111111`.

Circle publishes Solana Devnet USDC as `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` at <https://developers.circle.com/stablecoins/usdc-contract-addresses>. On this RPC the mint exists, owner `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`, decimals 6. It was set only in a gitignored local `.env`. `.env.example` stays blank.

`initialize_config` signature `4FJ9TCsd4GeQPFfUwTqWxT9etwrBLsVvVZdsUCm4xRohbzxhtKDNesqkx4eWKo8kW6VvL3wzQAA1nnvUen7Xnw5U`, slot `507202579`, finalized, success. Config PDA `J87z2ui9vP62U6gjGDiK23QdxVhr4j2FLwcRpzyQKb5y` stores that mint, the token program, and decimals 6. There is no withdrawal authority.

The API `GET /matches/10000000-0000-4000-8000-000000000001/contests` created H2H-5 off chain: contest `2ee3b8b1-cb75-426e-a2d0-9c36d734d9f8`, fee `5000000`, capacity `2`, status `OPEN`, lock `2026-10-10T15:00:00.000Z`, filled `0/2`. `initialize_contest` signature `3CTaMKAQiuYiV6hHsbDQyPjo31oxPm761GKjtuLGtQVEbRQdjULtVChFdTwh7A1Bo87SL8mcEuJ74pw6LiXK6X2i`, slot `507202613`, finalized, success. Contest PDA `DEQHAiMiKeVQdWzvxVjcPaaaMExiUpcguKMHJzGk2Ukb`. Vault `3HpRkESYi5PY4hm8CnumNN3R2jdWYcCHV37eSZ5suVex` is that PDA's USDC ATA, amount 0, decimals 6. On-chain fee, capacity, lock, and status `0` (joinable) match the off-chain row.

Deposit did not run. The payer's USDC balance of that mint is 0. Circle's public faucet (`https://faucet.circle.com/api/graphql`, `requestToken`) returned `RECAPTCHA_ERROR`. No substitute mint was created. No reservation, no deposit signature, no indexer run, and no `ENTRY_CONFIRMED`. `docs/devnet-proof.md` is still absent.
