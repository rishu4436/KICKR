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
export {
  assertFreeDevHarnessAllowed,
  isFreeDevHarnessAllowed,
} from "./dev-gate.js";
export { LocalDevScoringActorRegistry } from "./local-dev-scoring-actor.js";
export {
  E2E_MATCH_FORWARD_PATH,
  advanceMatchAlongPath,
  advanceMatchForward,
  appendLateLocalDevEvents,
  finalizeFreeFromLiveScores,
  harnessAllowed,
  rebuildLiveScores,
  seedFreshLocalDevMatch,
  type DevE2eDeps,
} from "./dev-e2e-harness.js";
