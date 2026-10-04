use std::str::FromStr;

use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::{instruction::Instruction, system_program};
use solana_sha256_hasher::hashv;
use anchor_lang::{InstructionData, ToAccountMetas};
use anchor_spl::associated_token::{get_associated_token_address_with_program_id, ID as ASSOCIATED_TOKEN_PROGRAM_ID};
use anchor_spl::token::ID as TOKEN_PROGRAM_ID;
use litesvm::LiteSVM;
use litesvm_token::{
    spl_token::state::Account as SplAccount, CreateAssociatedTokenAccount, CreateMint, MintTo,
    get_spl_account,
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

fn leaf(entry_id: [u8; 16], amount: u64, claimant: &Pubkey) -> [u8; 32] {
    hashv(&[
        b"KICKR_PAYOUT_V1",
        entry_id.as_ref(),
        &amount.to_le_bytes(),
        claimant.as_ref(),
    ])
    .to_bytes()
}

fn parent(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    if a <= b {
        hashv(&[&a, &b]).to_bytes()
    } else {
        hashv(&[&b, &a]).to_bytes()
    }
}

fn merkle_root(leaves: &[[u8; 32]]) -> ([u8; 32], Vec<Vec<[u8; 32]>>) {
    let mut layers: Vec<Vec<[u8; 32]>> = vec![leaves.to_vec()];
    while layers.last().unwrap().len() > 1 {
        let current = layers.last().unwrap();
        let mut next = Vec::new();
        let mut i = 0;
        while i < current.len() {
            if i + 1 < current.len() {
                next.push(parent(current[i], current[i + 1]));
            } else {
                next.push(parent(current[i], current[i]));
            }
            i += 2;
        }
        layers.push(next);
    }
    let mut proofs = Vec::new();
    for index in 0..leaves.len() {
        let mut proof = Vec::new();
        let mut idx = index;
        for level in 0..layers.len() - 1 {
            let layer = &layers[level];
            let sibling = if idx % 2 == 0 { idx + 1 } else { idx - 1 };
            if sibling < layer.len() {
                proof.push(layer[sibling]);
            } else {
                proof.push(layer[idx]);
            }
            idx /= 2;
        }
        proofs.push(proof);
    }
    (layers.last().unwrap()[0], proofs)
}

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

fn dispatch(world: &mut World, ix: Instruction, extra: Option<&Keypair>) -> bool {
    let blockhash = world.svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&world.payer.pubkey()), &blockhash);
    let tx = match extra {
        Some(user) => VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&world.payer, user]),
        None => VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[&world.payer]),
    };
    match tx {
        Ok(tx) => world.svm.send_transaction(tx).is_ok(),
        Err(_) => false,
    }
}

fn send(svm: &mut LiteSVM, payer: &Keypair, ix: Instruction, signers: &[&Keypair]) {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), signers).unwrap();
    svm.send_transaction(tx).unwrap();
}

fn world(capacity: u32) -> World {
    let mut svm = LiteSVM::new();
    let payer = Keypair::new();
    svm.add_program(kickr_escrow::id(), program_bytes())
        .unwrap_or_else(|err| panic!("{err:?}"));
    svm.airdrop(&payer.pubkey(), 2_000_000_000).unwrap();
    let mint = CreateMint::new(&mut svm, &payer)
        .authority(&payer.pubkey())
        .decimals(6)
        .send()
        .unwrap();
    let mint = Pubkey::from_str(&mint.to_string()).unwrap();
    let (config, _) =
        Pubkey::find_program_address(&[kickr_escrow::constants::CONFIG_SEED], &kickr_escrow::id());
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
    let contest_id = [8u8; 16];
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
    World {
        svm,
        payer,
        mint,
        config,
        contest_id,
        contest,
        vault,
        fee,
    }
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

fn deposit(world: &mut World, user: &Keypair, ata: Pubkey) {
    let ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::Deposit {
            amount_base_units: world.fee,
            reservation_nonce_hash: [9u8; 32],
            team_version_id: [3u8; 16],
        }
        .data(),
        kickr_escrow::accounts::Deposit {
            user: user.pubkey(),
            user_token: ata,
            usdc_mint: world.mint,
            contest: world.contest,
            vault: world.vault,
            deposit_receipt: receipt_pda(world.contest, user.pubkey()),
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(dispatch(world, ix, Some(user)));
}

fn lock(world: &mut World) {
    let mut clock = world.svm.get_sysvar::<anchor_lang::prelude::Clock>();
    clock.unix_timestamp += 20_000;
    world.svm.set_sysvar(&clock);
    let ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::LockContest {}.data(),
        kickr_escrow::accounts::LockContest {
            contest: world.contest,
        }
        .to_account_metas(None),
    );
    assert!(dispatch(world, ix, None));
}

fn settlement_pda(contest: Pubkey, version: u32) -> Pubkey {
    Pubkey::find_program_address(
        &[
            kickr_escrow::constants::SETTLEMENT_SEED,
            contest.as_ref(),
            &version.to_le_bytes(),
        ],
        &kickr_escrow::id(),
    )
    .0
}

fn claim_pda(contest: Pubkey, version: u32, entry_id: [u8; 16]) -> Pubkey {
    Pubkey::find_program_address(
        &[
            kickr_escrow::constants::CLAIM_SEED,
            contest.as_ref(),
            &version.to_le_bytes(),
            entry_id.as_ref(),
        ],
        &kickr_escrow::id(),
    )
    .0
}

fn vault_amount(svm: &LiteSVM, vault: &Pubkey) -> u64 {
    let account: SplAccount = get_spl_account(svm, vault).unwrap();
    account.amount
}

fn commit(
    world: &mut World,
    version: u32,
    result_hash: [u8; 32],
    root: [u8; 32],
    payout: u64,
    fee: u64,
) -> bool {
    let ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::CommitSettlement {
            settlement_version: version,
            result_hash,
            merkle_root: root,
            total_payout_base_units: payout,
            fee_base_units: fee,
        }
        .data(),
        kickr_escrow::accounts::CommitSettlement {
            init_authority: world.payer.pubkey(),
            config: world.config,
            contest: world.contest,
            settlement: settlement_pda(world.contest, version),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    dispatch(world, ix, None)
}

fn claim(
    world: &mut World,
    user: &Keypair,
    ata: Pubkey,
    version: u32,
    entry_id: [u8; 16],
    amount: u64,
    proof: Vec<[u8; 32]>,
) -> bool {
    let ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::ClaimPayout {
            settlement_version: version,
            entry_id,
            amount_base_units: amount,
            proof,
        }
        .data(),
        kickr_escrow::accounts::ClaimPayout {
            claimant: user.pubkey(),
            contest: world.contest,
            settlement: settlement_pda(world.contest, version),
            claim: claim_pda(world.contest, version, entry_id),
            usdc_mint: world.mint,
            vault: world.vault,
            claimant_token: ata,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    dispatch(world, ix, Some(user))
}

#[test]
fn settlement_commit_and_claim_succeeds_once() {
    let mut world = world(2);
    let alice = Keypair::new();
    let bob = Keypair::new();
    let alice_ata = fund_user(&mut world, &alice, 1);
    let bob_ata = fund_user(&mut world, &bob, 1);
    deposit(&mut world, &alice, alice_ata);
    deposit(&mut world, &bob, bob_ata);
    lock(&mut world);
    let entry_alice = [1u8; 16];
    let payout = 9_000_000u64;
    let fee = 1_000_000u64;
    let leaf_a = leaf(entry_alice, payout, &alice.pubkey());
    let (root, proofs) = merkle_root(&[leaf_a]);
    let result_hash = [7u8; 32];
    assert!(commit(&mut world, 1, result_hash, root, payout, fee));
    assert_eq!(vault_amount(&world.svm, &world.vault), world.fee * 2);
    assert!(claim(
        &mut world,
        &alice,
        alice_ata,
        1,
        entry_alice,
        payout,
        proofs[0].clone()
    ));
    assert_eq!(vault_amount(&world.svm, &world.vault), fee);
    assert!(!claim(
        &mut world,
        &alice,
        alice_ata,
        1,
        entry_alice,
        payout,
        proofs[0].clone()
    ));
}

#[test]
fn duplicate_settlement_and_wrong_hash_fail() {
    let mut world = world(2);
    let alice = Keypair::new();
    let bob = Keypair::new();
    let a = fund_user(&mut world, &alice, 1);
    let b = fund_user(&mut world, &bob, 1);
    deposit(&mut world, &alice, a);
    deposit(&mut world, &bob, b);
    lock(&mut world);
    let entry = [1u8; 16];
    let payout = 9_000_000u64;
    let fee = 1_000_000u64;
    let leaf_a = leaf(entry, payout, &alice.pubkey());
    let (root, _) = merkle_root(&[leaf_a]);
    assert!(commit(&mut world, 1, [1u8; 32], root, payout, fee));
    assert!(!commit(&mut world, 1, [2u8; 32], root, payout, fee));
}

#[test]
fn wrong_claimant_or_amount_or_proof_fails() {
    let mut world = world(2);
    let alice = Keypair::new();
    let bob = Keypair::new();
    let a = fund_user(&mut world, &alice, 1);
    let b = fund_user(&mut world, &bob, 1);
    deposit(&mut world, &alice, a);
    deposit(&mut world, &bob, b);
    lock(&mut world);
    let entry = [1u8; 16];
    let payout = 9_000_000u64;
    let fee = 1_000_000u64;
    let leaf_a = leaf(entry, payout, &alice.pubkey());
    let (root, proofs) = merkle_root(&[leaf_a]);
    assert!(commit(&mut world, 1, [1u8; 32], root, payout, fee));
    assert!(!claim(
        &mut world,
        &bob,
        b,
        1,
        entry,
        payout,
        proofs[0].clone()
    ));
    assert!(!claim(
        &mut world,
        &alice,
        a,
        1,
        entry,
        payout - 1,
        proofs[0].clone()
    ));
    assert!(!claim(&mut world, &alice, a, 1, entry, payout, vec![[9u8; 32]]));
}

#[test]
fn void_and_refund_then_block_after_settlement() {
    let mut world = world(1);
    let alice = Keypair::new();
    let ata = fund_user(&mut world, &alice, 1);
    deposit(&mut world, &alice, ata);
    let void_ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::VoidContest {}.data(),
        kickr_escrow::accounts::VoidContest {
            init_authority: world.payer.pubkey(),
            config: world.config,
            contest: world.contest,
        }
        .to_account_metas(None),
    );
    assert!(dispatch(&mut world, void_ix, None));
    let refund_pda = Pubkey::find_program_address(
        &[
            kickr_escrow::constants::REFUND_SEED,
            world.contest.as_ref(),
            alice.pubkey().as_ref(),
        ],
        &kickr_escrow::id(),
    )
    .0;
    let refund_ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::ClaimRefund {}.data(),
        kickr_escrow::accounts::ClaimRefund {
            depositor: alice.pubkey(),
            contest: world.contest,
            deposit_receipt: receipt_pda(world.contest, alice.pubkey()),
            refund_claim: refund_pda,
            usdc_mint: world.mint,
            vault: world.vault,
            depositor_token: ata,
            token_program: TOKEN_PROGRAM_ID,
            associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    );
    assert!(dispatch(&mut world, refund_ix.clone(), Some(&alice)));
    assert_eq!(vault_amount(&world.svm, &world.vault), 0);
    assert!(!dispatch(&mut world, refund_ix, Some(&alice)));
}

#[test]
fn refund_after_settlement_fails() {
    let mut world = world(2);
    let alice = Keypair::new();
    let bob = Keypair::new();
    let a = fund_user(&mut world, &alice, 1);
    let b = fund_user(&mut world, &bob, 1);
    deposit(&mut world, &alice, a);
    deposit(&mut world, &bob, b);
    lock(&mut world);
    let entry = [1u8; 16];
    let payout = 9_000_000u64;
    let fee = 1_000_000u64;
    let leaf_a = leaf(entry, payout, &alice.pubkey());
    let (root, _) = merkle_root(&[leaf_a]);
    assert!(commit(&mut world, 1, [1u8; 32], root, payout, fee));
    let void_ix = Instruction::new_with_bytes(
        kickr_escrow::id(),
        &kickr_escrow::instruction::VoidContest {}.data(),
        kickr_escrow::accounts::VoidContest {
            init_authority: world.payer.pubkey(),
            config: world.config,
            contest: world.contest,
        }
        .to_account_metas(None),
    );
    assert!(!dispatch(&mut world, void_ix, None));
}
