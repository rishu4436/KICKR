import { DEV_V1_RULESET } from "../domain/scoring/dev-v1.js";
import type { FeePolicyRecord, PayoutPolicyRecord, ContestTemplateRecord } from "./types.js";
import { wholeUsdc } from "./types.js";
import { FREE_FEE_POLICY, FREE_PAYOUT_POLICIES, FREE_TEMPLATES } from "./free/catalog.js";

/**
 * Development contest config. Not a production fee or payout freeze.
 * Amounts are USDC base units (6 decimals). 5 USDC = 5000000.
 * TODO: production fee bps are unspecified. 1000 bps below is DEV only.
 */

const SEEDED_AT = "2026-01-01T00:00:00.000Z";

export const DEV_FEE_POLICY: FeePolicyRecord = {
  id: "51000000-0000-4000-8000-000000000001",
  version: 1,
  rateBps: 1000,
  configuration: {
    label: "DEV",
    note: "TODO: production fee bps are unspecified. 1000 is development config only and is not platform revenue.",
  },
  createdAt: SEEDED_AT,
};

export const DEV_PAYOUT_POLICIES: readonly PayoutPolicyRecord[] = [
  {
    id: "52000000-0000-4000-8000-000000000001",
    version: 1,
    policyType: "HEAD_TO_HEAD",
    configuration: { shape: "HEAD_TO_HEAD", calculation: "none" },
    createdAt: SEEDED_AT,
  },
  {
    id: "52000000-0000-4000-8000-000000000002",
    version: 1,
    policyType: "WINNER_TAKES_ALL",
    configuration: { shape: "WINNER_TAKES_ALL", calculation: "none" },
    createdAt: SEEDED_AT,
  },
  {
    id: "52000000-0000-4000-8000-000000000003",
    version: 1,
    policyType: "GRAND_LEAGUE",
    configuration: { shape: "GRAND_LEAGUE", calculation: "none" },
    createdAt: SEEDED_AT,
  },
  {
    id: "52000000-0000-4000-8000-000000000001",
    version: 2,
    policyType: "HEAD_TO_HEAD",
    configuration: {
      shape: "HEAD_TO_HEAD",
      calculation: "winner_takes_prize_pool",
      tiePolicy: "entry_id_asc",
      note: "DEV Phase 6. Winner gets 100% of prize pool after fees.",
    },
    createdAt: "2026-10-04T00:00:00.000Z",
  },
  {
    id: "52000000-0000-4000-8000-000000000002",
    version: 2,
    policyType: "WINNER_TAKES_ALL",
    configuration: {
      shape: "WINNER_TAKES_ALL",
      calculation: "winner_takes_prize_pool",
      tiePolicy: "entry_id_asc",
      note: "DEV Phase 6. Rank 1 gets 100% of prize pool after fees.",
    },
    createdAt: "2026-10-04T00:00:00.000Z",
  },
  {
    id: "52000000-0000-4000-8000-000000000003",
    version: 2,
    policyType: "GRAND_LEAGUE",
    configuration: {
      shape: "GRAND_LEAGUE",
      calculation: "rank_bps",
      tiePolicy: "entry_id_asc",
      ranks: [
        { rank: 1, bps: 4000 },
        { rank: 2, bps: 3000 },
        { rank: 3, bps: 2000 },
        { rank: 4, bps: 1000 },
      ],
      note: "DEV Phase 6 schedule. Sum of rank bps = 10000 of prize pool.",
    },
    createdAt: "2026-10-04T00:00:00.000Z",
  },
];

function template(
  id: string,
  code: string,
  type: ContestTemplateRecord["contestType"],
  wholeFee: number,
  capacity: number,
  payout: PayoutPolicyRecord,
): ContestTemplateRecord {
  const entryFeeBaseUnits = wholeUsdc(wholeFee);
  return {
    id,
    templateCode: code,
    contestType: type,
    contestKind: "PAID_DEVNET",
    entryFeeBaseUnits,
    prizePoolBaseUnits: 0,
    capacity,
    payoutPolicyId: payout.id,
    payoutPolicyVersion: payout.version,
    feePolicyId: DEV_FEE_POLICY.id,
    feePolicyVersion: DEV_FEE_POLICY.version,
    currency: "USDC",
    enabled: true,
    version: 1,
    createdAt: SEEDED_AT,
    updatedAt: SEEDED_AT,
  };
}

const h2h = DEV_PAYOUT_POLICIES.find((p) => p.policyType === "HEAD_TO_HEAD" && p.version === 2);
const wta = DEV_PAYOUT_POLICIES.find((p) => p.policyType === "WINNER_TAKES_ALL" && p.version === 2);
const grand = DEV_PAYOUT_POLICIES.find((p) => p.policyType === "GRAND_LEAGUE" && p.version === 2);
if (!h2h || !wta || !grand) {
  throw new Error("dev payout policies missing");
}

export const DEV_PAID_TEMPLATES: readonly ContestTemplateRecord[] = [
  template("53000000-0000-4000-8000-000000000001", "H2H-5", "HEAD_TO_HEAD", 5, 2, h2h),
  template("53000000-0000-4000-8000-000000000002", "H2H-10", "HEAD_TO_HEAD", 10, 2, h2h),
  template("53000000-0000-4000-8000-000000000003", "H2H-20", "HEAD_TO_HEAD", 20, 2, h2h),
  template("53000000-0000-4000-8000-000000000004", "H2H-50", "HEAD_TO_HEAD", 50, 2, h2h),
  template("53000000-0000-4000-8000-000000000005", "GRAND-5", "GRAND_LEAGUE", 5, 1000, grand),
  template("53000000-0000-4000-8000-000000000006", "WTA-20", "WINNER_TAKES_ALL", 20, 10, wta),
];

/** All seeded templates: FREE product templates plus paid Devnet infrastructure. */
export const DEV_TEMPLATES: readonly ContestTemplateRecord[] = [
  ...FREE_TEMPLATES,
  ...DEV_PAID_TEMPLATES,
];

export { FREE_FEE_POLICY, FREE_PAYOUT_POLICIES, FREE_TEMPLATES };

export const DEV_SCORING_SNAPSHOT = {
  scoringRulesetId: DEV_V1_RULESET.rulesetId,
  scoringRulesetVersion: DEV_V1_RULESET.version,
  scoringRulesetName: DEV_V1_RULESET.name,
};
