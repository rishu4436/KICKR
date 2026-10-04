//! PDA seeds. Every seed is listed here and in docs/phase-6-settlement.md.
//!
//! - config: ["config"]
//! - contest: ["contest", contest_id] where contest_id is 16 bytes
//! - deposit receipt: ["deposit", contest_pda, depositor_wallet]
//! - settlement: ["settlement", contest_pda, settlement_version_le_u32]
//! - claim: ["claim", contest_pda, settlement_version_le_u32, entry_id]
//! - refund claim: ["refund", contest_pda, depositor_wallet]
//!
//! The vault is the associated token account of the contest PDA. Only
//! claim_payout and claim_refund may sign for the vault. There is no
//! withdraw-to-admin, sweep, or arbitrary transfer.

pub const CONFIG_SEED: &[u8] = b"config";
pub const CONTEST_SEED: &[u8] = b"contest";
pub const DEPOSIT_SEED: &[u8] = b"deposit";
pub const SETTLEMENT_SEED: &[u8] = b"settlement";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const REFUND_SEED: &[u8] = b"refund";

pub const STATUS_JOINABLE: u8 = 0;
pub const STATUS_FULL: u8 = 1;
pub const STATUS_LOCKED: u8 = 2;
pub const STATUS_SETTLED: u8 = 3;
pub const STATUS_VOIDED: u8 = 4;

pub const RECEIPT_DEPOSITED: u8 = 1;
pub const RECEIPT_REFUNDED: u8 = 2;

pub const SETTLEMENT_ACTIVE: u8 = 1;
pub const SETTLEMENT_VOIDED: u8 = 2;

pub const LEAF_PREFIX: &[u8] = b"KICKR_PAYOUT_V1";
