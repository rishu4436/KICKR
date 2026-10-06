/** FREE contest product surface. Keep paid/escrow imports out of callers that only need FREE. */
export { FREE_FEE_POLICY, FREE_PAYOUT_POLICIES, FREE_TEMPLATES, FREE_TEMPLATE_IDS } from "./catalog.js";
export {
  InMemoryFreeResultStore,
  finalizeFreeContest,
  freeClaimUiState,
  rankFreeEntries,
  type FreeContestResult,
  type FreeResultRow,
  type FreeResultStore,
} from "./results.js";
