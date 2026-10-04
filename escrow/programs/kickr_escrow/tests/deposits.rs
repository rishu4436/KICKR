use std::str::FromStr;

use anchor_lang::prelude::{AccountDeserialize, Pubkey};
use anchor_lang::solana_program::{instruction::Instruction, system_program};
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::associated_token::get_associated_token_address_with_program_id;
use anchor_spl::token::ID as TOKEN_PROGRAM_ID;
use anchor_spl::associated_token::ID as ASSOCIATED_TOKEN_PROGRAM_ID;
use litesvm::LiteSVM;
use litesvm_token::{
    spl_token::state::Account as SplAccount,
    CreateAssociatedTokenAccount, CreateMint, MintTo, get_spl_account,
};
use solana_keypair::Keypair;
use solana_message::{Message, VersionedMessage};
use solana_signer::Signer;
use solana_transaction::versioned::VersionedTransaction;

fn program_bytes() -> &'static [u8] {
    include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/kickr_escrow.so"
    ))
}

fn svm() -> (LiteSVM, Keypair) {
    let mut svm = LiteSVM::new();
    let payer = Keypair::new();
    svm.add_program(kickr_escrow::id(), program_bytes()).unwrap_or_else(|err| panic!("{err:?}"));
    svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();
    (svm, payer)
}


fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction, signers: &[&Keypair]) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).unwrap();
}

fn dispatch(world: &mut World, ix: Instruction, user: Option<&Keypair>) -> bool {
    let blockhash = world.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&world.payer.pubkey()), &blockhash);
    let tx = match user {
        Some(user) => VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&world.payer, user]),
        None => VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&world.payer]),
    };
    match tx {
        Ok(tx) => world.svm.send_transaction(tx).is_ok(),
        Err(_) => false,
    }
}

#[allow(dead_code)]
struct World {
    svm: LiteSVM,
    payer: Keypair,
    mint: Pubkey,
    config: Pubkey,
    contest_id: [u8; 16],
    contest: Pubkey,
    vault: Pubkey,
    fee: u64,
}

fn world(capacity: u32) -> World {
    let (mut svm, payer) = svm();
    let mint = CreateMint::new(&mut svm, &payer)
        .authority(&payer.pubkey())
        .decimals(6)
        .send()
        .unwrap();
    let mint = Pubkey::from_str(&mint.to_string()).unwrap();
    let (config, _) = Pubkey::find_program_address(&[kickr_escrow::constants::CONFIG_SEED], &kickr_escrow::id());
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            kickr_escrow::id(),
            &kickr_escrow::instruction::InitializeConfig {}.data(),
            kickr_escrow::accounts::InitializeConfig {
                init_authority: payer.pubkey(),
                config,
                usdc_mint: mint,
                token_program: TOKEN_PROGRAM_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        &[&payer],
    );
    let contest_id = [7u8; 16];
    let (contest, _) = Pubkey::find_program_address(
        &[kickr_escrow::constants::CONTEST_SEED, contest_id.as_ref()],
        &kickr_escrow::id(),
    );
    let vault = get_associated_token_address_with_program_id(&contest, &mint, &TOKEN_PROGRAM_ID);
    let clock = svm.get_sysvar::<anchor_lang::prelude::Clock>();
    let fee = 5_000_000u64;
    send(
        &mut svm,
        &payer,
        Instruction::new_with_bytes(
            kickr_escrow::id(),
            &kickr_escrow::instruction::InitializeContest {
                contest_id,
                entry_fee_base_units: fee,
                capacity,
                lock_at: clock.unix_timestamp + 10_000,
            }
            .data(),
            kickr_escrow::accounts::InitializeContest {
                init_authority: payer.pubkey(),
                config,
                contest,
                usdc_mint: mint,
                vault,
                token_program: TOKEN_PROGRAM_ID,
                associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
                system_program: system_program::ID,
            }
            .to_account_metas(None),
        ),
        &[&payer],
    );
    World { svm, payer, mint, config, contest_id, contest, vault, fee }
}

fn fund_user(world: &mut World, user: &Keypair, times: u64) -> Pubkey {
    let amount = world.fee * times;
    let mint = world.mint;
    world.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
    let ata = CreateAssociatedTokenAccount::new(&mut world.svm, &world.payer, &mint)
        .owner(&user.pubkey())
        .send()
        .unwrap();
    let ata = Pubkey::from_str(&ata.to_string()).unwrap();
    MintTo::new(&mut world.svm, &world.payer, &mint, &ata, amount)
        .owner(&world.payer)
        .send()
        .unwrap();
    ata
}

fn deposit_ix(user: &Keypair, user_ata: Pubkey, amount: u64, vault: Pubkey, receipt: Pubkey, contest: Pubkey, mint: Pubkey) -> Instruction {
    let nonce = [9u8; 32];
    let team = [3u8; 16];
    Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::Deposit {
            amount_base_units: amount,
            reservation_nonce_hash: nonce,
            team_version_id: team,
        }
        .data(),
        kickr_escrow::accounts::Deposit {
            user: user.pubkey(),
            user_token: user_ata,
            usdc_mint: mint,
            contest,
            vault,
            deposit_receipt: receipt,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

fn receipt_pda(contest: Pubkey, user: Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[
            kickr_escrow::constants::DEPOSIT_SEED,
            contest.as_ref(),
            user.as_ref(),
        ],
        &kickr_escrow::id(),
    )
    .0
}

fn vault_amount(svm: &LiteSVM, vault: &Pubkey) -> u64 {
    let account: SplAccount = get_spl_account(svm, vault).unwrap();
    account.amount
}


fn ok_deposit(world: &mut World, user: &Keypair, ata: Pubkey, amount: u64) {
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    let ix = deposit_ix(user, ata, amount, vault, receipt_pda(contest, user.pubkey()), contest, mint);
    assert!(dispatch(world, ix, Some(user)));
}

fn fails_deposit(world: &mut World, user: &Keypair, ata: Pubkey, amount: u64, vault: Pubkey, contest: Pubkey, mint: Pubkey, signed: bool) -> bool {
    let ix = deposit_ix(user, ata, amount, vault, receipt_pda(contest, user.pubkey()), contest, mint);
    !dispatch(world, ix, if signed { Some(user) } else { None })
}

fn contest_count(svm: &LiteSVM, contest: &Pubkey) -> u32 {
    let account = svm.get_account(contest).unwrap();
    let mut data: &[u8] = &account.data;
    kickr_escrow::state::ContestEscrow::try_deserialize(&mut data)
        .unwrap()
        .current_deposit_count
}

#[test]
fn valid_deposit_moves_exact_fee_and_writes_receipt() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let fee = world.fee;
    let contest = world.contest;
    let mint = world.mint;
    let contest_id = world.contest_id;
    ok_deposit(&mut world, &user, ata, fee);
    assert_eq!(vault_amount(&world.svm, &world.vault), fee);
    assert_eq!(contest_count(&world.svm, &contest), 1);
    let receipt = receipt_pda(contest, user.pubkey());
    let stored = world.svm.get_account(&receipt).unwrap();
    let mut data: &[u8] = &stored.data;
    let receipt_state = kickr_escrow::state::DepositReceipt::try_deserialize(&mut data).unwrap();
    assert_eq!(receipt_state.amount_base_units, fee);
    assert_eq!(receipt_state.depositor, user.pubkey());
    assert_eq!(receipt_state.mint, mint);
    assert_eq!(receipt_state.contest_id, contest_id);
}

#[test]
fn wrong_amount_does_not_move_tokens() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let before = vault_amount(&world.svm, &world.vault);
    let amount = world.fee - 1;
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &user, ata, amount, vault, contest, mint, true));
    assert_eq!(vault_amount(&world.svm, &vault), before);
    assert_eq!(contest_count(&world.svm, &contest), 0);
}

#[test]
fn wrong_mint_is_rejected() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let payer_pk = world.payer.pubkey();
    let other = CreateMint::new(&mut world.svm, &world.payer)
        .authority(&payer_pk)
        .decimals(6)
        .send()
        .unwrap();
    let other = Pubkey::from_str(&other.to_string()).unwrap();
    let fee = world.fee;
    let vault = world.vault;
    let contest = world.contest;
    assert!(fails_deposit(&mut world, &user, ata, fee, vault, contest, other, true));
    assert_eq!(vault_amount(&world.svm, &vault), 0);
}

#[test]
fn wrong_owner_is_rejected() {
    let mut world = world(2);
    let user = Keypair::new();
    let other = Keypair::new();
    let ata = fund_user(&mut world, &other, 1);
    world.svm.airdrop(&user.pubkey(), 1_000_000_000).unwrap();
    let fee = world.fee;
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &user, ata, fee, vault, contest, mint, true));
    assert_eq!(vault_amount(&world.svm, &vault), 0);
}

#[test]
fn non_signer_is_rejected() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let fee = world.fee;
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &user, ata, fee, vault, contest, mint, false));
    assert_eq!(vault_amount(&world.svm, &vault), 0);
}

#[test]
fn full_contest_rejects_the_next_deposit() {
    let mut world = world(1);
    let first = Keypair::new();
    let second = Keypair::new();
    let first_ata = fund_user(&mut world, &first, 1);
    let second_ata = fund_user(&mut world, &second, 1);
    let fee = world.fee;
    ok_deposit(&mut world, &first, first_ata, fee);
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &second, second_ata, fee, vault, contest, mint, true));
    assert_eq!(contest_count(&world.svm, &contest), 1);
    assert_eq!(vault_amount(&world.svm, &vault), fee);
}

#[test]
fn duplicate_depositor_is_rejected() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 2);
    let fee = world.fee;
    ok_deposit(&mut world, &user, ata, fee);
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &user, ata, fee, vault, contest, mint, true));
    assert_eq!(vault_amount(&world.svm, &vault), fee);
}

#[test]
fn locked_contest_is_rejected() {
    let mut world = world(2);
    let mut clock = world.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    clock.unix_timestamp += 20_000;
    world.svm.set_sysvar(&clock);
    let contest = world.contest;
    let ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::LockContest {}.data(),
        kickr_escrow::accounts::LockContest { contest }.to_account_metas(None),
    );
    assert!(dispatch(&mut world, ix, None));
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let fee = world.fee;
    let vault = world.vault;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &user, ata, fee, vault, contest, mint, true));
    assert_eq!(vault_amount(&world.svm, &vault), 0);
}

#[test]
fn invalid_contest_account_is_rejected() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let fake = Keypair::new().pubkey();
    let fee = world.fee;
    let vault = world.vault;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &user, ata, fee, vault, fake, mint, true));
}

#[test]
fn vault_mismatch_is_rejected() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let fee = world.fee;
    let contest = world.contest;
    let mint = world.mint;
    let vault = world.vault;
    assert!(fails_deposit(&mut world, &user, ata, fee, ata, contest, mint, true));
    assert_eq!(vault_amount(&world.svm, &vault), 0);
}

#[test]
fn receipt_mismatch_is_rejected() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 1);
    let payer = world.payer.pubkey();
    let fee = world.fee;
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    let wrong = receipt_pda(contest, payer);
    let ix = deposit_ix(&user, ata, fee, vault, wrong, contest, mint);
    assert!(!dispatch(&mut world, ix, Some(&user)));
    assert_eq!(vault_amount(&world.svm, &vault), 0);
}

#[test]
fn replay_of_the_same_deposit_does_not_move_tokens_twice() {
    let mut world = world(2);
    let user = Keypair::new();
    let ata = fund_user(&mut world, &user, 2);
    let fee = world.fee;
    ok_deposit(&mut world, &user, ata, fee);
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &user, ata, fee, vault, contest, mint, true));
    assert_eq!(vault_amount(&world.svm, &vault), fee);
    assert_eq!(contest_count(&world.svm, &contest), 1);
}

#[test]
fn n_users_fill_the_exact_capacity() {
    let mut world = world(3);
    let fee = world.fee;
    for _ in 0..3 {
        let user = Keypair::new();
        let ata = fund_user(&mut world, &user, 1);
        ok_deposit(&mut world, &user, ata, fee);
    }
    let contest = world.contest;
    let vault = world.vault;
    let mint = world.mint;
    assert_eq!(contest_count(&world.svm, &contest), 3);
    assert_eq!(vault_amount(&world.svm, &vault), fee * 3);
    let late = Keypair::new();
    let ata = fund_user(&mut world, &late, 1);
    assert!(fails_deposit(&mut world, &late, ata, fee, vault, contest, mint, true));
}

#[test]
fn two_users_racing_the_last_seat_let_exactly_one_succeed() {
    let mut world = world(1);
    let alice = Keypair::new();
    let bob = Keypair::new();
    let alice_ata = fund_user(&mut world, &alice, 1);
    let bob_ata = fund_user(&mut world, &bob, 1);
    let fee = world.fee;
    ok_deposit(&mut world, &alice, alice_ata, fee);
    let vault = world.vault;
    let contest = world.contest;
    let mint = world.mint;
    assert!(fails_deposit(&mut world, &bob, bob_ata, fee, vault, contest, mint, true));
    assert_eq!(contest_count(&world.svm, &contest), 1);
    assert_eq!(vault_amount(&world.svm, &vault), fee);
    assert!(world.svm.get_account(&receipt_pda(contest, bob.pubkey())).is_none());
}

#[test]
fn source_has_no_admin_sweep_or_arbitrary_transfer() {
    let blob = include_str!("../src/lib.rs").to_string()
        + include_str!("../src/instructions/deposit.rs")
        + include_str!("../src/instructions/initialize_config.rs")
        + include_str!("../src/instructions/initialize_contest.rs")
        + include_str!("../src/instructions/lock_contest.rs")
        + include_str!("../src/instructions/commit_settlement.rs")
        + include_str!("../src/instructions/claim_payout.rs")
        + include_str!("../src/instructions/void_contest.rs")
        + include_str!("../src/instructions/claim_refund.rs");
    for needle in ["fn withdraw", "fn admin_transfer", "fn arbitrary_transfer", "fn withdraw_all", "fn sweep"] {
        assert!(!blob.contains(needle), "{needle}");
    }
    // Vault spends are only claim_payout / claim_refund with commitment checks.
    assert!(blob.contains("claim_payout"));
    assert!(blob.contains("claim_refund"));
    assert!(!include_str!("../src/instructions/commit_settlement.rs").contains("transfer_checked"));
    assert!(!include_str!("../src/instructions/void_contest.rs").contains("transfer_checked"));
}
