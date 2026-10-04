use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{Mint, TokenAccount, TokenInterface},
};

use crate::{constants::STATUS_JOINABLE, error::EscrowError, state::{ContestEscrow, EscrowConfig}};

#[derive(Accounts)]
#[instruction(contest_id: [u8; 16])]
pub struct InitializeContest<'info> {
    #[account(mut)]
    pub init_authority: Signer<'info>,
    #[account(
        seeds = [crate::constants::CONFIG_SEED],
        bump = config.bump,
        has_one = init_authority,
        has_one = usdc_mint,
        has_one = token_program
    )]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        init,
        payer = init_authority,
        space = 8 + ContestEscrow::INIT_SPACE,
        seeds = [crate::constants::CONTEST_SEED, contest_id.as_ref()],
        bump
    )]
    pub contest: Account<'info, ContestEscrow>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        init,
        payer = init_authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = contest,
        associated_token::token_program = token_program
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_contest(
    ctx: Context<InitializeContest>,
    contest_id: [u8; 16],
    entry_fee_base_units: u64,
    capacity: u32,
    lock_at: i64,
) -> Result<()> {
    require!(entry_fee_base_units > 0, EscrowError::BadFee);
    require!(capacity > 0, EscrowError::BadCapacity);
    let now = Clock::get()?.unix_timestamp;
    require!(lock_at > now, EscrowError::BadLockTime);
    require!(
        ctx.accounts.usdc_mint.decimals == ctx.accounts.config.decimals,
        EscrowError::WrongMint
    );

    let contest = &mut ctx.accounts.contest;
    contest.contest_id = contest_id;
    contest.usdc_mint = ctx.accounts.usdc_mint.key();
    contest.token_program = ctx.accounts.token_program.key();
    contest.entry_fee_base_units = entry_fee_base_units;
    contest.capacity = capacity;
    contest.current_deposit_count = 0;
    contest.status = STATUS_JOINABLE;
    contest.created_at = now;
    contest.lock_at = lock_at;
    contest.bump = ctx.bumps.contest;
    Ok(())
}
