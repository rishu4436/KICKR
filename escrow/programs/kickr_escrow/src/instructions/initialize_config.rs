use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenInterface};

use crate::state::EscrowConfig;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub init_authority: Signer<'info>,
    #[account(
        init,
        payer = init_authority,
        space = 8 + EscrowConfig::INIT_SPACE,
        seeds = [crate::constants::CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, EscrowConfig>,
    pub usdc_mint: InterfaceAccount<'info, Mint>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn handle_initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.init_authority = ctx.accounts.init_authority.key();
    config.usdc_mint = ctx.accounts.usdc_mint.key();
    config.token_program = ctx.accounts.token_program.key();
    config.decimals = ctx.accounts.usdc_mint.decimals;
    config.bump = ctx.bumps.config;
    Ok(())
}
