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

Program id in source: `DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN`. Not deployed.

A throwaway payer was created only in `/tmp` (not in git). `solana airdrop 2` against `https://api.devnet.solana.com` failed: `error sending request for url (https://api.devnet.solana.com/)`. No devnet transaction was signed or broadcast. There is no vault address, no deposit signature, and no explorer link. Local LiteSVM tests are the proof that ran. This is not a fake devnet signature.
