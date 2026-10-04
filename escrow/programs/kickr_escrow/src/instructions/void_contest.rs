use anchor_lang::prelude::*;

use crate::{
    constants::{STATUS_FULL, STATUS_JOINABLE, STATUS_LOCKED, STATUS_SETTLED, STATUS_VOIDED},
    error::EscrowError,
    state::{ContestEscrow, ContestVoided, EscrowConfig},
};

/// Marks a contest void before settlement. Enables refund claims. No USDC move.
#[derive(Accounts)]
pub struct VoidContest<'info> {
    pub init_authority: Signer<'info>,
    #[account(
        seeds = [crate::constants::CONFIG_SEED],
        bump = config.bump,
        has_one = init_authority @ EscrowError::InvalidAuthority
    )]
    pub config: Account<'info, EscrowConfig>,
    #[account(
        mut,
        seeds = [crate::constants::CONTEST_SEED, contest.contest_id.as_ref()],
        bump = contest.bump
    )]
    pub contest: Account<'info, ContestEscrow>,
}

pub fn handle_void_contest(ctx: Context<VoidContest>) -> Result<()> {
    let status = ctx.accounts.contest.status;
    require!(status != STATUS_SETTLED, EscrowError::ContestSettled);
    require!(status != STATUS_VOIDED, EscrowError::ContestVoided);
    require!(
        status == STATUS_JOINABLE || status == STATUS_FULL || status == STATUS_LOCKED,
        EscrowError::NotJoinable
    );
    ctx.accounts.contest.status = STATUS_VOIDED;
    emit!(ContestVoided {
        contest_id: ctx.accounts.contest.contest_id,
    });
    Ok(())
}
