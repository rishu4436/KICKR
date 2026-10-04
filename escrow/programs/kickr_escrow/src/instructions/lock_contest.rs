use anchor_lang::prelude::*;

use crate::{constants::STATUS_LOCKED, error::EscrowError, state::ContestEscrow};

/// Closes joins after lock time. Does not move tokens and has no authority to.
#[derive(Accounts)]
pub struct LockContest<'info> {
    #[account(
        mut,
        seeds = [crate::constants::CONTEST_SEED, contest.contest_id.as_ref()],
        bump = contest.bump
    )]
    pub contest: Account<'info, ContestEscrow>,
}

pub fn handle_lock_contest(ctx: Context<LockContest>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.contest.lock_at, EscrowError::ContestLocked);
    ctx.accounts.contest.status = STATUS_LOCKED;
    Ok(())
}
