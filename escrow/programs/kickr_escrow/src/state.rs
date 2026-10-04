use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct EscrowConfig {
    pub init_authority: Pubkey,
    pub usdc_mint: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ContestEscrow {
    pub contest_id: [u8; 16],
    pub usdc_mint: Pubkey,
    pub token_program: Pubkey,
    pub entry_fee_base_units: u64,
    pub capacity: u32,
    pub current_deposit_count: u32,
    pub status: u8,
    pub created_at: i64,
    pub lock_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DepositReceipt {
    pub contest_id: [u8; 16],
    pub depositor: Pubkey,
    pub amount_base_units: u64,
    pub mint: Pubkey,
    pub reservation_nonce_hash: [u8; 32],
    pub team_version_id: [u8; 16],
    pub created_at: i64,
    pub status: u8,
    pub bump: u8,
}

/// On-chain commitment of an approved off-chain payout set.
/// Funds move only via claim_payout with a valid merkle proof.
#[account]
#[derive(InitSpace)]
pub struct SettlementCommitment {
    pub contest_id: [u8; 16],
    pub contest: Pubkey,
    pub settlement_version: u32,
    pub result_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub total_payout_base_units: u64,
    pub fee_base_units: u64,
    pub status: u8,
    pub created_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PayoutClaim {
    pub contest_id: [u8; 16],
    pub settlement_version: u32,
    pub entry_id: [u8; 16],
    pub claimant: Pubkey,
    pub amount_base_units: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct RefundClaim {
    pub contest_id: [u8; 16],
    pub depositor: Pubkey,
    pub amount_base_units: u64,
    pub claimed_at: i64,
    pub bump: u8,
}

#[event]
pub struct DepositRecorded {
    pub contest_id: [u8; 16],
    pub depositor: Pubkey,
    pub amount_base_units: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub deposit_receipt: Pubkey,
    pub reservation_nonce_hash: [u8; 32],
    pub team_version_id: [u8; 16],
    pub deposit_count: u32,
}

#[event]
pub struct SettlementCommitted {
    pub contest_id: [u8; 16],
    pub settlement_version: u32,
    pub result_hash: [u8; 32],
    pub merkle_root: [u8; 32],
    pub total_payout_base_units: u64,
    pub fee_base_units: u64,
}

#[event]
pub struct PayoutClaimed {
    pub contest_id: [u8; 16],
    pub settlement_version: u32,
    pub entry_id: [u8; 16],
    pub claimant: Pubkey,
    pub amount_base_units: u64,
    pub vault: Pubkey,
}

#[event]
pub struct ContestVoided {
    pub contest_id: [u8; 16],
}

#[event]
pub struct RefundClaimed {
    pub contest_id: [u8; 16],
    pub depositor: Pubkey,
    pub amount_base_units: u64,
    pub vault: Pubkey,
}
