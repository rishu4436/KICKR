//! PDA seeds. Every seed is listed here and in ESCROW.md.
//!
//! - config: ["config"]
//! - contest: ["contest", contest_id] where contest_id is 16 bytes
//! - deposit receipt: ["deposit", contest_pda, depositor_wallet]
//!
//! The vault is not a program PDA. It is the associated token account of the
//! contest PDA for the configured USDC mint and token program. No private key
//! is the vault authority.

pub const CONFIG_SEED: &[u8] = b"config";
pub const CONTEST_SEED: &[u8] = b"contest";
pub const DEPOSIT_SEED: &[u8] = b"deposit";

pub const STATUS_JOINABLE: u8 = 0;
pub const STATUS_FULL: u8 = 1;
pub const STATUS_LOCKED: u8 = 2;
pub const RECEIPT_DEPOSITED: u8 = 1;
