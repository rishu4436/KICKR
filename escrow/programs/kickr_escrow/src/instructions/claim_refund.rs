use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked},
};

use crate::{
    constants::{
        CONTEST_SEED, DEPOSIT_SEED, RECEIPT_DEPOSITED, RECEIPT_REFUNDED, REFUND_SEED, STATUS_SETTLED,
        STATUS_VOIDED,
    },
    error::EscrowError,
    state::{ContestEscrow, DepositReceipt, RefundClaim, RefundClaimed},
};

/// Refund a confirmed deposit after void. Replay-safe via RefundClaim PDA.
#[derive(Accounts)]
pub struct ClaimRefund<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut,
        seeds = [CONTEST_SEED, contest.contest_id.as_ref()],
        bump = contest.bump,
        constraint = contest.status == STATUS_VOIDED @ EscrowError::ContestVoided,
        constraint = contest.status != STATUS_SETTLED @ EscrowError::RefundAfterSettlement
    )]
    pub contest: Account<'info, ContestEscrow>,
    #[account(
        mut,
        seeds = [DEPOSIT_SEED, contest.key().as_ref(), depositor.key().as_ref()],
        bump = deposit_receipt.bump,
        constraint = deposit_receipt.depositor == depositor.key() @ EscrowError::WrongClaimant,
        constraint = deposit_receipt.contest_id == contest.contest_id @ EscrowError::WrongContest,
        constraint = deposit_receipt.status == RECEIPT_DEPOSITED @ EscrowError::NotRefundable
    )]
    pub deposit_receipt: Account<'info, DepositReceipt>,
    #[account(
        init,
        payer = depositor,
        space = 8 + RefundClaim::INIT_SPACE,
        seeds = [REFUND_SEED, contest.key().as_ref(), depositor.key().as_ref()],
        bump
    )]
    pub refund_claim: Account<'info, RefundClaim>,
    #[account(address = contest.usdc_mint @ EscrowError::WrongMint)]
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = contest,
        associated_token::token_program = token_program,
        constraint = vault.owner == contest.key() @ EscrowError::VaultMismatch
    )]
    pub vault: InterfaceAccount<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = depositor,
        associated_token::token_program = token_program
    )]
    pub depositor_token: InterfaceAccount<'info, TokenAccount>,
    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
    let amount = ctx.accounts.deposit_receipt.amount_base_units;
    require!(amount > 0, EscrowError::WrongAmount);
    require!(
        amount == ctx.accounts.contest.entry_fee_base_units,
        EscrowError::WrongAmount
    );
    require!(
        ctx.accounts.vault.amount >= amount,
        EscrowError::InsufficientVault
    );
    require!(
        ctx.accounts.depositor_token.owner == ctx.accounts.depositor.key(),
        EscrowError::WrongClaimant
    );
    require!(
        ctx.accounts.token_program.key() == ctx.accounts.contest.token_program,
        EscrowError::WrongTokenProgram
    );

    ctx.accounts.deposit_receipt.status = RECEIPT_REFUNDED;

    let refund = &mut ctx.accounts.refund_claim;
    refund.contest_id = ctx.accounts.contest.contest_id;
    refund.depositor = ctx.accounts.depositor.key();
    refund.amount_base_units = amount;
    refund.claimed_at = Clock::get()?.unix_timestamp;
    refund.bump = ctx.bumps.refund_claim;

    let contest_id = ctx.accounts.contest.contest_id;
    let bump = ctx.accounts.contest.bump;
    let seeds: &[&[u8]] = &[CONTEST_SEED, contest_id.as_ref(), &[bump]];

    token_interface::transfer_checked(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.usdc_mint.to_account_info(),
                to: ctx.accounts.depositor_token.to_account_info(),
                authority: ctx.accounts.contest.to_account_info(),
            },
            &[seeds],
        ),
        amount,
        ctx.accounts.usdc_mint.decimals,
    )?;

    emit!(RefundClaimed {
        contest_id,
        depositor: ctx.accounts.depositor.key(),
        amount_base_units: amount,
        vault: ctx.accounts.vault.key(),
    });
    Ok(())
}
