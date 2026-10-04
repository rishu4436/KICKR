use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{RECEIPT_DEPOSITED, STATUS_FULL, STATUS_JOINABLE, STATUS_LOCKED},
    error::EscrowError,
    state::{ContestEscrow, DepositReceipt, DepositRecorded},
};

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program
    )]
    pub user_token: InterfaceAccount<'info, TokenAccount>,
    #[account(address = contest.usdc_mint @ EscrowError::WrongMint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        seeds = [crate::constants::CONTEST_SEED, contest.contest_id.as_ref()],
        bump = contest.bump,
        constraint = contest.token_program == token_program.key() @ EscrowError::WrongTokenProgram
    )]
    pub contest: Account<'info, ContestEscrow>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = contest,
        associated_token::token_program = token_program,
        constraint = vault.owner == contest.key() @ EscrowError::VaultMismatch
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        init,
        payer = user,
        space = 8 + DepositReceipt::INIT_SPACE,
        seeds = [crate::constants::DEPOSIT_SEED, contest.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub deposit_receipt: Account<'info, DepositReceipt>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_deposit(
    ctx: Context<Deposit>,
    amount_base_units: u64,
    reservation_nonce_hash: [u8; 32],
    team_version_id: [u8; 16],
) -> Result<()> {
    let contest = &ctx.accounts.contest;
    let now = Clock::get()?.unix_timestamp;
    require!(now < contest.lock_at, EscrowError::ContestLocked);
    require!(contest.status != STATUS_LOCKED, EscrowError::ContestLocked);
    require!(
        contest.current_deposit_count < contest.capacity,
        EscrowError::ContestFull
    );
    require!(contest.status == STATUS_JOINABLE, EscrowError::NotJoinable);
    require!(
        amount_base_units == contest.entry_fee_base_units,
        EscrowError::WrongAmount
    );
    require!(
        ctx.accounts.user_token.owner == ctx.accounts.user.key(),
        EscrowError::VaultMismatch
    );
    require!(
        ctx.accounts.user_token.mint == contest.usdc_mint,
        EscrowError::WrongMint
    );

    let next = contest
        .current_deposit_count
        .checked_add(1)
        .ok_or(EscrowError::CountOverflow)?;

    let contest = &mut ctx.accounts.contest;
    contest.current_deposit_count = next;
    if next == contest.capacity {
        contest.status = STATUS_FULL;
    }

    let receipt = &mut ctx.accounts.deposit_receipt;
    receipt.contest_id = contest.contest_id;
    receipt.depositor = ctx.accounts.user.key();
    receipt.amount_base_units = amount_base_units;
    receipt.mint = contest.usdc_mint;
    receipt.reservation_nonce_hash = reservation_nonce_hash;
    receipt.team_version_id = team_version_id;
    receipt.created_at = now;
    receipt.status = RECEIPT_DEPOSITED;
    receipt.bump = ctx.bumps.deposit_receipt;

    token_interface::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.user_token.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        amount_base_units,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(DepositRecorded {
        contest_id: contest.contest_id,
        depositor: ctx.accounts.user.key(),
        amount_base_units,
        mint: contest.usdc_mint,
        vault: ctx.accounts.vault.key(),
        deposit_receipt: ctx.accounts.deposit_receipt.key(),
        reservation_nonce_hash,
        team_version_id,
        deposit_count: contest.current_deposit_count,
    });
    Ok(())
}
