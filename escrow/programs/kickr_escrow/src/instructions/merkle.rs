use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

use crate::constants::LEAF_PREFIX;

/// Canonical leaf: sha256(LEAF_PREFIX || entry_id || amount_le || claimant).
pub fn payout_leaf(entry_id: &[u8; 16], amount: u64, claimant: &Pubkey) -> [u8; 32] {
    let amount_bytes = amount.to_le_bytes();
    hashv(&[LEAF_PREFIX, entry_id.as_ref(), amount_bytes.as_ref(), claimant.as_ref()]).to_bytes()
}

/// Sorted-pair merkle: parent = sha256(min(a,b) || max(a,b)).
pub fn merkle_parent(a: [u8; 32], b: [u8; 32]) -> [u8; 32] {
    if a <= b {
        hashv(&[&a, &b]).to_bytes()
    } else {
        hashv(&[&b, &a]).to_bytes()
    }
}

pub fn verify_proof(leaf: [u8; 32], proof: &[[u8; 32]], root: [u8; 32]) -> bool {
    let mut current = leaf;
    for sibling in proof {
        current = merkle_parent(current, *sibling);
    }
    current == root
}
