/**
 * FREE contest templates. Module boundary: no USDC, no escrow, no monetary payouts.
 * Existing fantasy rules (C 2x, VC 1.5x, milli-points, entry_id_asc ties) still apply.
 */
import type { ContestTemplateRecord, FeePolicyRecord, PayoutPolicyRecord } from "../types.js";

const SEEDED_AT = "2026-10-06T00:00:00.000Z";

/** Fee policy for FREE: 0 bps, not platform revenue. DEV paid fee (1000) is untouched. */
export const FREE_FEE_POLICY: FeePolicyRecord = {
  id: "51000000-0000-4000-8000-0000000000f1",
  version: 1,
  rateBps: 0,
  configuration: {
    label: "FREE",
    note: "FREE contests have no fee and no monetary prize. Not platform revenue.",
  },
  createdAt: SEEDED_AT,
};

export const FREE_PAYOUT_POLICIES: readonly PayoutPolicyRecord[] = [
  {
    id: "52000000-0000-4000-8000-0000000000f1",
    version: 1,
    policyType: "HEAD_TO_HEAD",
    configuration: {
      shape: "HEAD_TO_HEAD",
      calculation: "none",
      monetary: false,
      tiePolicy: "entry_id_asc",
      note: "FREE H2H. Rank and score only. No USDC payout.",
    },
    createdAt: SEEDED_AT,
  },
  {
    id: "52000000-0000-4000-8000-0000000000f3",
    version: 1,
    policyType: "GRAND_LEAGUE",
    configuration: {
      shape: "GRAND_LEAGUE",
      calculation: "none",
      monetary: false,
      tiePolicy: "entry_id_asc",
      note: "FREE Grand League. Rank and score only. No USDC payout.",
    },
    createdAt: SEEDED_AT,
  },
];

function freeTemplate(
  id: string,
  code: string,
  type: ContestTemplateRecord["contestType"],
  capacity: number,
  payout: PayoutPolicyRecord,
): ContestTemplateRecord {
  return {
    id,
    templateCode: code,
    contestType: type,
    entryFeeBaseUnits: 0,
    prizePoolBaseUnits: 0,
    capacity,
    payoutPolicyId: payout.id,
    payoutPolicyVersion: payout.version,
    feePolicyId: FREE_FEE_POLICY.id,
    feePolicyVersion: FREE_FEE_POLICY.version,
    currency: "USDC",
    contestKind: "FREE",
    enabled: true,
    version: 1,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  };
}

const freeH2h = FREE_PAYOUT_POLICIES.find((p) => p.policyType === "HEAD_TO_HEAD");
const freeGrand = FREE_PAYOUT_POLICIES.find((p) => p.policyType === "GRAND_LEAGUE");
if (!freeH2h || !freeGrand) {
  throw new Error("free payout policies missing");
}

export const FREE_TEMPLATES: readonly ContestTemplateRecord[] = [
  freeTemplate("53000000-0000-4000-8000-0000000000f1", "FREE-H2H", "HEAD_TO_HEAD", 2, freeH2h),
  freeTemplate("53000000-0000-4000-8000-0000000000f5", "FREE-GRAND", "GRAND_LEAGUE", 1000, freeGrand),
];

export const FREE_TEMPLATE_IDS = {
  H2H: "53000000-0000-4000-8000-0000000000f1",
  GRAND: "53000000-0000-4000-8000-0000000000f5",
} as const;
