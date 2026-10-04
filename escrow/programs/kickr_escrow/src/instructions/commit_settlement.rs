use anchor_lang::prelude::*;

use crate::{
    constants::{SETTLEMENT_ACTIVE, SETTLEMENT_SEED, STATUS_LOCKED, STATUS_SETTLED},
    error::EscrowError,
    state::{ContestEscrow, EscrowConfig, SettlementCommitment, SettlementCommitted},
};

/// Commits an approved payout merkle root. Does not transfer tokens.
/// Init authority may commit; it still cannot transfer arbitrary amounts.
#[derive(Accounts)]
#[instruction(settlement_version: u32)]
pub struct CommitSettlement<'info> {
    #[account(mut)]
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
    #[account(
        init,
        payer = init_authority,
        space = 8 + SettlementCommitment::INIT_SPACE,
        seeds = [
            SETTLEMENT_SEED,
            contest.key().as_ref(),
            &settlement_version.to_le_bytes()
        ],
        bump
    )]
    pub settlement: Account<'info, SettlementCommitment>,
    pub system_program: Program<'info, System>,
}

pub fn handle_commit_settlement(
    ctx: Context<CommitSettlement>,
    settlement_version: u32,
    result_hash: [u8; 32],
    merkle_root: [u8; 32],
    total_payout_base_units: u64,
    fee_base_units: u64,
) -> Result<()> {
    require!(settlement_version > 0, EscrowError::BadSettlementVersion);
    require!(
        ctx.accounts.contest.status == STATUS_LOCKED
            || ctx.accounts.contest.status == crate::constants::STATUS_FULL,
        EscrowError::ContestNotLocked
    );
    // FULL contests must still be time-locked before settlement.
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ctx.accounts.contest.lock_at, EscrowError::ContestNotLocked);
    require!(
        ctx.accounts.contest.status != crate::constants::STATUS_VOIDED,
        EscrowError::ContestVoided
    );
    require!(
        ctx.accounts.contest.status != STATUS_SETTLED,
        EscrowError::ContestSettled
    );

    let total = total_payout_base_units
        .checked_add(fee_base_units)
        .ok_or(EscrowError::Overflow)?;
    let pot = (ctx.accounts.contest.entry_fee_base_units as u128)
        .checked_mul(ctx.accounts.contest.current_deposit_count as u128)
        .ok_or(EscrowError::Overflow)?;
    require!(total as u128 <= pot, EscrowError::WrongPayoutAmount);

    let settlement = &mut ctx.accounts.settlement;
    settlement.contest_id = ctx.accounts.contest.contest_id;
    settlement.contest = ctx.accounts.contest.key();
    settlement.settlement_version = settlement_version;
    settlement.result_hash = result_hash;
    settlement.merkle_root = merkle_root;
    settlement.total_payout_base_units = total_payout_base_units;
    settlement.fee_base_units = fee_base_units;
    settlement.status = SETTLEMENT_ACTIVE;
    settlement.created_at = now;
    settlement.bump = ctx.bumps.settlement;

    ctx.accounts.contest.status = STATUS_SETTLED;

    emit!(SettlementCommitted {
        contest_id: settlement.contest_id,
        settlement_version,
        result_hash,
        merkle_root,
        total_payout_base_units,
        fee_base_units,
    });
    Ok(())
}
