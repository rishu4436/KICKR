pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN");

/// Deposit-only contest escrow.
///
/// The contest PDA is the vault authority. This crate has no instruction that
/// signs for the vault, and no private key can move the vault. Init authority
/// may create config and contests. It cannot withdraw.
///
/// Instructions: initialize_config, initialize_contest, deposit, lock_contest.
/// There is no withdraw, refund, settle, or admin_transfer instruction.
#[program]
pub mod kickr_escrow {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::handle_initialize_config(ctx)
    }

    pub fn initialize_contest(
        ctx: Context<InitializeContest>,
        contest_id: [u8; 16],
        entry_fee_base_units: u64,
        capacity: u32,
        lock_at: i64,
    ) -> Result<()> {
        instructions::initialize_contest::handle_initialize_contest(
            ctx,
            contest_id,
            entry_fee_base_units,
            capacity,
            lock_at,
        )
    }

    pub fn deposit(
        ctx: Context<Deposit>,
        amount_base_units: u64,
        reservation_nonce_hash: [u8; 32],
        team_version_id: [u8; 16],
    ) -> Result<()> {
        instructions::deposit::handle_deposit(
            ctx,
            amount_base_units,
            reservation_nonce_hash,
            team_version_id,
        )
    }

    /// Time lock only. Does not transfer tokens.
    pub fn lock_contest(ctx: Context<LockContest>) -> Result<()> {
        instructions::lock_contest::handle_lock_contest(ctx)
    }
}
