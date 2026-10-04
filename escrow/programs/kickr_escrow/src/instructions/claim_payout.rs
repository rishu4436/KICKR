use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{CLAIM_SEED, CONTEST_SEED, SETTLEMENT_ACTIVE, SETTLEMENT_SEED, STATUS_SETTLED},
    error::EscrowError,
    instructions::merkle::{payout_leaf, verify_proof},
    state::{ContestEscrow, PayoutClaim, PayoutClaimed, SettlementCommitment},
};

/// Permissionless claim against a committed merkle root.
/// Transfers from the program-controlled vault ATA to the claimant.
#[derive(Accounts)]
#[instruction(settlement_version: u32, entry_id: [u8; 16], amount_base_units: u64)]
pub struct ClaimPayout<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(
        mut,
        seeds = [CONTEST_SEED, contest.contest_id.as_ref()],
        bump = contest.bump,
        constraint = contest.status == STATUS_SETTLED @ EscrowError::ContestNotLocked
    )]
    pub contest: Account<'info, ContestEscrow>,
    #[account(
        seeds = [
            SETTLEMENT_SEED,
            contest.key().as_ref(),
            &settlement_version.to_le_bytes()
        ],
        bump = settlement.bump,
        constraint = settlement.contest == contest.key() @ EscrowError::WrongContest,
        constraint = settlement.contest_id == contest.contest_id @ EscrowError::WrongContest,
        constraint = settlement.settlement_version == settlement_version @ EscrowError::WrongContest,
        constraint = settlement.status == SETTLEMENT_ACTIVE @ EscrowError::SettlementInactive
    )]
    pub settlement: Account<'info, SettlementCommitment>,
    #[account(
        init,
        payer = claimant,
        space = 8 + PayoutClaim::INIT_SPACE,
        seeds = [
            CLAIM_SEED,
            contest.key().as_ref(),
            &settlement_version.to_le_bytes(),
            entry_id.as_ref()
        ],
        bump
    )]
    pub claim: Account<'info, PayoutClaim>,
    #[account(address = contest.usdc_mint @ EscrowError::WrongMint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = contest,
        associated_token::token_program = token_program,
        constraint = vault.owner == contest.key() @ EscrowError::VaultMismatch,
        constraint = vault.mint == contest.usdc_mint @ EscrowError::WrongMint
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = claimant,
        associated_token::token_program = token_program
    )]
    pub claimant_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_payout(
    ctx: Context<ClaimPayout>,
    settlement_version: u32,
    entry_id: [u8; 16],
    amount_base_units: u64,
    proof: Vec<[u8; 32]>,
) -> Result<()> {
    require!(amount_base_units > 0, EscrowError::WrongPayoutAmount);
    require!(
        ctx.accounts.vault.amount >= amount_base_units,
        EscrowError::InsufficientVault
    );
    require!(
        ctx.accounts.claimant_token.owner == ctx.accounts.claimant.key(),
        EscrowError::WrongClaimant
    );
    require!(
        ctx.accounts.claimant_token.mint == ctx.accounts.contest.usdc_mint,
        EscrowError::WrongMint
    );
    require!(
        ctx.accounts.token_program.key() == ctx.accounts.contest.token_program,
        EscrowError::WrongTokenProgram
    );

    let leaf = payout_leaf(&entry_id, amount_base_units, &ctx.accounts.claimant.key());
    require!(
        verify_proof(leaf, &proof, ctx.accounts.settlement.merkle_root),
        EscrowError::InvalidProof
    );

    let claim = &mut ctx.accounts.claim;
    claim.contest_id = ctx.accounts.contest.contest_id;
    claim.settlement_version = settlement_version;
    claim.entry_id = entry_id;
    claim.claimant = ctx.accounts.claimant.key();
    claim.amount_base_units = amount_base_units;
    claim.claimed_at = Clock::get()?.unix_timestamp;
    claim.bump = ctx.bumps.claim;

    let contest_id = ctx.accounts.contest.contest_id;
    let bump = ctx.accounts.contest.bump;
    let seeds: &[&[u8]] = &[CONTEST_SEED, contest_id.as_ref(), &[bump]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.claimant_token.to_account_info(),
                authority: ctx.accounts.contest.to_account_info(),
            },
            &[seeds],
        ),
        amount_base_units,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(PayoutClaimed {
        contest_id,
        settlement_version,
        entry_id,
        claimant: ctx.accounts.claimant.key(),
        amount_base_units,
        vault: ctx.accounts.vault.key(),
    });
    Ok(())
}
