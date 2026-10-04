pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("DpmpV74AC91sbHtjRV8VWfBjaAdM143Jub47eG5nEGQN");

/// Contest escrow with deposit, settlement commitment, and claim.
///
/// The contest PDA is the vault authority. Init authority may create config,
/// contests, commit settlements, and void contests. It cannot transfer arbitrary
/// amounts to arbitrary wallets. Vault spends happen only in claim_payout and
/// claim_refund, each gated by commitment / deposit receipt checks.
///
/// Instructions: initialize_config, initialize_contest, deposit, lock_contest,
/// commit_settlement, claim_payout, void_contest, claim_refund.
/// There is no withdraw-to-admin, sweep, or generic transfer.
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

    /// Commit approved payout merkle root. Does not transfer tokens.
    pub fn commit_settlement(
        ctx: Context<CommitSettlement>,
        settlement_version: u32,
        result_hash: [u8; 32],
        merkle_root: [u8; 32],
        total_payout_base_units: u64,
        fee_base_units: u64,
    ) -> Result<()> {
        instructions::commit_settlement::handle_commit_settlement(
            ctx,
            settlement_version,
            result_hash,
            merkle_root,
            total_payout_base_units,
            fee_base_units,
        )
    }

    /// Claim a payout leaf. Second claim for the same entry fails (PDA init).
    pub fn claim_payout(
        ctx: Context<ClaimPayout>,
        settlement_version: u32,
        entry_id: [u8; 16],
        amount_base_units: u64,
        proof: Vec<[u8; 32]>,
    ) -> Result<()> {
        instructions::claim_payout::handle_claim_payout(
            ctx,
            settlement_version,
            entry_id,
            amount_base_units,
            proof,
        )
    }

    /// Void before settlement. Enables refund claims. No USDC movement.
    pub fn void_contest(ctx: Context<VoidContest>) -> Result<()> {
        instructions::void_contest::handle_void_contest(ctx)
    }

    /// Refund a voided contest deposit. Replay-safe. Fails after settlement.
    pub fn claim_refund(ctx: Context<ClaimRefund>) -> Result<()> {
        instructions::claim_refund::handle_claim_refund(ctx)
    }
}
