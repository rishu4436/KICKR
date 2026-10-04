use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("Contest is not joinable")]
    NotJoinable,
    #[msg("Contest is full")]
    ContestFull,
    #[msg("Contest is locked")]
    ContestLocked,
    #[msg("Deposit amount must equal the entry fee")]
    WrongAmount,
    #[msg("Mint does not match the contest")]
    WrongMint,
    #[msg("Token program does not match the contest")]
    WrongTokenProgram,
    #[msg("Capacity must be greater than zero")]
    BadCapacity,
    #[msg("Entry fee must be greater than zero")]
    BadFee,
    #[msg("Lock time must be in the future at creation")]
    BadLockTime,
    #[msg("Deposit count overflow")]
    CountOverflow,
    #[msg("Vault authority is not the contest account")]
    VaultMismatch,
    #[msg("This program has no instruction that spends the vault arbitrarily")]
    NoVaultSpender,
    #[msg("Invalid settlement authority")]
    InvalidAuthority,
    #[msg("Contest is not locked for settlement")]
    ContestNotLocked,
    #[msg("Settlement already exists for this version")]
    DuplicateSettlement,
    #[msg("Settlement is not active")]
    SettlementInactive,
    #[msg("Settlement does not belong to this contest")]
    WrongContest,
    #[msg("Result hash mismatch")]
    WrongResultHash,
    #[msg("Invalid merkle proof")]
    InvalidProof,
    #[msg("Claim already consumed")]
    ClaimConsumed,
    #[msg("Claimant wallet does not match commitment")]
    WrongClaimant,
    #[msg("Payout amount does not match commitment")]
    WrongPayoutAmount,
    #[msg("Vault has insufficient balance")]
    InsufficientVault,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Contest is voided")]
    ContestVoided,
    #[msg("Contest is already settled")]
    ContestSettled,
    #[msg("Refund after settlement is forbidden")]
    RefundAfterSettlement,
    #[msg("Deposit receipt is not refundable")]
    NotRefundable,
    #[msg("Settlement version must be greater than zero")]
    BadSettlementVersion,
}
