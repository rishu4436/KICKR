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
    #[msg("This program has no instruction that spends the vault")]
    NoVaultSpender,
}
