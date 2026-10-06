# Phase 10: Real external result attestor (evaluation)

**Outcome: we have not integrated an external attestor.** Every option we found has one of two problems. Either it gives no signature that a party other than KICKR produced over a football result, or it gives one only after accounts, keys, or deployments KICKR does not have. Without those, nothing can be tested for real from this machine. Under the Phase 10 rule, this phase therefore ships documentation only. Phase 9 verification (`attestation/*`) is unchanged. Production stays fail-closed: it has no approved non-`LOCAL_DEV` attestor, so `ATTESTOR_REGISTRY_EMPTY` / `LOCAL_DEV_ATTESTOR_FORBIDDEN` still block settlement advancement.

Research date: 2026-10-06. Every claim below cites a URL that was fetched or searched on that date.

## 1. What Phase 9 needs an attestor to sign

The Phase 9 `ResultAttestation` binds `matchId`, `contestId`, scoring ruleset id/version, `providerSource`, `finalizedSnapshotHash` (a hash over KICKR's APPROVED fantasy snapshots), and `resultHash` (the settlement payload hash). The signature is Ed25519 over the `KICKR_RESULT_ATTESTATION_V1` canonical hash, and the signing key comes from `APPROVED_ATTESTORS` (see `docs/phase-9-attestation.md`).

So a "real" attestor has to do more than relay a match score. It must either:

- **(A)** sign the provider's raw final match facts, which KICKR then deterministically re-derives into the snapshot/result hash. The facts are attested; the derivation is reproducible by anyone. Or:
- **(B)** independently fetch the provider data, run KICKR's published deterministic scoring itself, and sign the resulting `finalizedSnapshotHash` / `resultHash`.

In both cases the signer must be someone other than KICKR, and its key must be verifiable: a published public key or an on-chain account.

## 2. Findings per provider

| Provider | Auth to API | Response signing / crypto proof? | Verifiable vs trusted | Sources |
|---|---|---|---|---|
| **Sportmonks** (current adapter) | API token as `api_token` query param or raw `Authorization` header | **No.** The docs describe token auth, JSON `data` envelopes, and rate-limit metadata only. No response signature or proof is documented. | Data is fully trusted. TLS protects only the transport to KICKR, and KICKR could forge a copy for anyone else. | https://docs.sportmonks.com/v3/welcome/authentication ; https://www.sportmonks.com/glossary/http-headers/ ; https://docs.sportmonks.com/v3/api/error-codes |
| **Sportradar** | `x-api-key` header; push feeds are long-lived authenticated streams | **Partial, symmetric only.** Insights push webhooks carry an HMAC-SHA256 over `${timestamp}.${body}` with a shared secret. KICKR would hold that same secret, so it could forge the HMAC. This is not third-party-verifiable. | Trusted. Integrity is provable only between Sportradar and the secret holder. | https://developer.sportradar.com/getting-started/docs/authentication ; https://developer.sportradar.com/insights/v2/reference/nfl-push-feed ; https://developer.sportradar.com/baseball/docs/mlb-ig-push |
| **Stats Perform / Opta (SDAPI)** | OAuth / outlet auth key in path | **No** public signing documented | Trusted | https://developers.statsperform.com/feed-ma1-detailed-fixtures-results ; https://www.statsperform.com/faqs/stats-perform-faqs-security-encryption/ |
| **Genius Sports** | Commercial official-data API; contract access | **No** public response-signing scheme found. Its prediction-market role is supplying "official data" to Polymarket/Kalshi. Polymarket settles on-chain via UMA, not via a Genius signature. | Trusted (official data rights, but no cryptographic proof) | https://www.geniussports.com/engage/official-sports-data-api/ ; https://investors.geniussports.com/news/news-details/2026/Polymarket-and-Genius-Sports-Expand-the-Role-of-Official-Data-Exclusive-Live-Sports-Streaming-and-Integrity-Services-in-Prediction-Markets/default.aspx ; https://github.com/Polymarket/uma-sports-oracle |
| **API-Football (api-sports.io)** | `x-apisports-key` header | **No** | Trusted | https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide |
| **TheRundown / SportsDataIO** | API key (RapidAPI / vendor portal) | **Only via their own Chainlink nodes.** They state they "cryptographically sign that data on-chain", but delivery is Chainlink Direct Request to **EVM** consumer contracts. Coverage is mainly US sports plus MLS. | The node's on-chain signature is verifiable (on EVM). Data is still trusted. | https://blog.therundown.io/chainlink-2 ; https://sportsdata.io/sportsdataio-launches-live-chainlink-node-giving-smart-contracts-access-to-premium-sports-data ; https://docs.linkwellnodes.io/services/direct-request-jobs/examples/sports-data/TheRundown |

**Conclusion:** none of the licensed football providers we checked publicly documents an asymmetric signature over its responses that a third party could verify.

## 3. Findings per oracle / attestation infrastructure

| Option | Mechanism | Solana Devnet today | What is cryptographically verifiable | What is still trusted | Usable from this box / with our accounts | Sources |
|---|---|---|---|---|---|---|
| **Chainlink Functions** | DON runs JS, aggregates results, uses threshold-encrypted secrets | **No.** The supported-networks page lists EVM chains only (Arbitrum, Avalanche, Base, Celo, Ethereum, OP, Polygon, Soneium, ZKSync). | DON report signatures (EVM) | Data provider; DON honest majority | No (no Solana) | https://docs.chain.link/chainlink-functions/supported-networks ; https://docs.chain.link/chainlink-functions |
| **Chainlink Data Feeds** | Push price feeds | Yes (Solana Mainnet/Devnet) but **price feeds only, no sports results** | Feed transmissions | DON | Not applicable | https://docs.chain.link/data-feeds/solana |
| **Chainlink CRE** (Runtime Environment) | Workflow (TS/Go) uses the HTTP capability to fetch an API. The DON reaches consensus and signs a report (ECDSA + keccak256 for the Solana encoder). The Keystone Forwarder program verifies the signatures and CPIs into a receiver `on_report`. | **Yes, write-only.** Solana Devnet chain selector `16423721717087811551`. Devnet forwarder `7kuEAA3mSC1Tz8gQjnvH7bKFda9xSPRRin9SZbH49cNK` exists (read-only RPC `getAccountInfo` through onfinality returned an executable program). | DON-signed report over **arbitrary bytes**, so it can sign KICKR's own `resultHash` (pattern B). Signer quorum is checked by the forwarder. | Data provider (e.g. Sportmonks); DON honest majority; Chainlink's forwarder/DON config | **No.** Deploying a workflow to a DON "requires approval" (`cre account access` request). We have no CRE account, no deploy access, no Sportmonks token. Local `cre workflow simulate` uses a **mock** forwarder, which is not a real attestation. | https://docs.chain.link/cre/capabilities/solana-write ; https://docs.chain.link/cre/supported-networks-ts ; https://docs.chain.link/cre/account/deploy-access ; https://docs.chain.link/cre/guides/workflow/using-solana-client/onchain-write-ts |
| **Switchboard On-Demand** | Oracle job (HttpTask + JsonParseTask) runs on oracles inside TEEs (AMD SEV-SNP), which guardians attest. The oracle signs a quote (Ed25519 sig-verify ix on Solana). Credentials go in as `variableOverrides`. | **Yes.** On-Demand program `Aio4gaXjXzJNVLtzwtNVmSqGKpANtXhybbkhtAC94ji2` exists on Devnet (read-only RPC check returned an executable program). | Oracle Ed25519 signature over **numeric** feed outputs; TEE code integrity | Data provider; TEE vendor; Switchboard guardian/queue config. Per Switchboard's docs, override values (API key, and any semantic override) "are not included in the feed ID or the signed checksum". | **No.** Crossbar gateway `crossbar.switchboard.xyz` fails TLS from this box (`unexpected eof`). No Sportmonks token. Outputs are numeric feed values, so it can sign e.g. home/away goals (pattern A) but not KICKR's full event-level snapshot/result hash. Publishing quotes on-chain needs Devnet transactions, which this phase forbids. | https://docs.switchboard.xyz/custom-feeds/build-and-deploy-feed/deploy-feed ; https://docs.switchboard.xyz/custom-feeds/advanced-feed-configuration/data-feed-variable-overrides ; https://docs.switchboard.xyz/how-it-works/technical-architecture/trusted-execution-environments-tees ; https://docs.switchboard.xyz/ai-agents-llms/switchboard-agent-skill/switchboard-solana-svm-feeds ; https://docs.rs/switchboard-on-demand-client/latest/switchboard_on_demand_client/ |
| **Pyth** | First-party publisher price feeds; Kalshi event-probability feeds | Price feeds yes; **no sports results.** Asset classes are crypto, US equities, FX, metals, rates, commodities, energy. Kalshi feeds are *probabilities*, not final results. | Publisher signatures (Wormhole/Pythnet) | Publishers | Not applicable to final match results | https://docs.pyth.network/price-feeds/core/price-feeds/asset-classes ; https://www.pyth.network/blog/pyth-network-partners-with-kalshi-to-deliver-real-time-prediction-market-data-onchain |
| **UMA Optimistic Oracle (V2/V3)** | Bonded assertion, challenge window, DVM vote on dispute (used by Polymarket sports) | **No.** Network list is EVM only; DVM on Ethereum. | Nothing cryptographic about the *data*. Security is economic (bonds + token vote). | Proposers/disputers, UMA voters, Risk Labs multisig on some chains | No (EVM bonds/gas needed) | https://docs.uma.xyz/resources/network-addresses ; https://docs.uma.xyz/developers/optimistic-oracle-v3/quick-start ; https://github.com/Polymarket/uma-sports-oracle |
| **API3 Airnode / Signed API** | **First-party**: the *API provider itself* runs an Airnode and signs (ECDSA, EIP-191) `templateId,timestamp,encodedValue` | EVM-oriented | Provider signature, but only if the provider runs the Airnode | Provider | **No.** We found no Sportmonks (or other football provider) Airnode. If KICKR ran Airnode itself, that would be KICKR self-signing, which is forbidden. | https://airnode-docs.api3.org/guides/airnode/setting-up-airnode/ ; https://github.com/api3dao/signed-api/blob/main/packages/airnode-feed/README.md ; https://airnodehub-docs.api3.org/airnode/attestation |
| **TLSNotary** | MPC-TLS: a Verifier/Notary co-holds TLS session keys and signs commitments to the transcript and server identity | Not verifiable on-chain today ("planned upgrades") | **Origin proof**: the response came from the cert-chained domain (e.g. `api.sportmonks.com`). This is the only option that proves the data came *from the provider*. | Notary neutrality (must not collude with the prover = KICKR); data provider correctness. TLSNotary says itself that it "does not solve the Oracle Problem". | **No independent notary available.** Running our own notary = KICKR self-attesting. Also needs a Sportmonks token. TLS 1.2 only. | https://tlsnotary.org/docs/faq/ ; https://tlsnotary.github.io/docs-mdbook/intro.html |
| **Reclaim Protocol (zkTLS)** | Attestor proxies TLS and signs a claim; JS `verifyProof`; Solana Anchor verifier | Solana verifier program exists in SDK/examples (deploy + epoch config required) | Attestor signature over claim + transcript proof | Reclaim-operated attestors (AVS decentralisation via EigenLayer); provider | **No.** Needs a Reclaim app ID/secret and provider config, plus a Sportmonks token. On-chain verification would need a Devnet deploy/tx. | https://github.com/reclaimprotocol/attestor-core/ ; https://github.com/reclaimprotocol/attestor-core/blob/master/docs/avs.md ; https://docs.reclaimprotocol.org/onchain/solana/quickstart ; https://docs.reclaimprotocol.org/manual/js-sdk/usage |
| **Opacity** | zkTLS on MPC/TLSNotary with TEE + stake/slashing for notaries | No Solana verifier documented | Notary signature | Notary set/TEE | No account | https://docs.opacity.network/ |
| **Pluto Web Proofs** | MPC / proxy / TEE modes | Not documented for Solana. The old repo is archived as `legacy-web-prover`; production status is unclear. | Notary/TEE attestation | Pluto TEE/notary | No | https://pluto.xyz/blog/web-proof-techniques-tee-mode ; https://github.com/pluto/legacy-web-prover ; https://pluto.xyz/blog/introducing-pluto |
| **Chainlink DECO** | zkTLS-style three-party handshake | **Sandbox only.** Public sandbox since 2024-10-30; no production/mainnet availability found. | n/a for production | n/a | No | https://docs.chain.link/changelog/deco-sandbox ; https://chain.link/blog/deco-sandbox |

### Verifiable vs trusted: bottom line

- **No option removes trust in the sports data provider.** At best you get proof that a non-KICKR party fetched the data (oracle DON or TEE), or that the bytes came from the provider's TLS server (zkTLS). The provider's *correctness* is always trusted.
- **What can be cryptographically verified:**
  - who signed (a DON quorum, a TEE-attested oracle key, or a notary key);
  - that the signed bytes match KICKR's claims;
  - with zkTLS, that the data came from a specific domain.
- **What cannot be:** that the match really ended that way, or (without pattern B) that KICKR's fantasy scoring is correct. Pattern A narrows the latter because KICKR's scoring is deterministic and reproducible from attested inputs.

## 4. Local environment checks (2026-10-06)

| Check | Result |
|---|---|
| Sportmonks token in `.env` | **Absent.** The config expects `SPORTS_API_KEY` (`config/schema.ts`), and `.env` has no such variable. `SPORTS_DATA_PROVIDER` is `local-dev`. Checked by variable name only; no values printed. |
| `api.sportmonks.com` reachability | Reachable (HTTP 401 without a token) |
| Solana Devnet RPC | `https://solana-devnet.api.onfinality.io/public` works (`getSlot` OK). Read-only `getAccountInfo` confirmed the CRE Devnet forwarder and Switchboard On-Demand Devnet program exist. **No transactions sent.** |
| Switchboard Crossbar | `crossbar.switchboard.xyz`: TLS connect error (unexpected EOF) from this box |
| Chainlink CRE account / deploy access | None |
| Reclaim app credentials | None |

## 5. Chosen target architecture (not implemented yet: blocked on accounts)

**Chainlink CRE workflow → DON-signed report, verified off-chain by KICKR and optionally on Solana via the Keystone Forwarder into a separate receiver program (never `escrow/`).**

Why CRE over the others:

1. It is the only option that is live on **Solana Devnet** *and* can sign **arbitrary bytes**. That allows pattern B: the workflow fetches Sportmonks, runs KICKR's published deterministic scoring ruleset, and signs `{matchId, contestId, rulesetId, rulesetVersion, providerSource, finalizedSnapshotHash, resultHash, issuedAt}`.
2. The signer is a Chainlink DON quorum, not KICKR. KICKR cannot impersonate it.
3. Provider API secrets stay inside the DON secrets mechanism, not in the KICKR backend's signing path.

Runner-up: **Switchboard On-Demand** (pattern A, numeric final-score facts only, Ed25519, already Solana-native). It is weaker because outputs are numeric and override values are outside the signed checksum.

### Trust assumptions (exact)

1. The Sportmonks data is correct (the provider is trusted).
2. The Chainlink DON has an honest quorum (F+1 of N signers), and Chainlink's forwarder/DON signer-set configuration is correct.
3. The workflow source and ruleset hash are pinned. KICKR controls the workflow deployment, so the workflow **code hash must be published and pinned in config**, so that a KICKR-modified workflow is detectable.
4. KICKR's deterministic scoring code equals the code the workflow runs (verified by matching `scoringRulesetVersion` and a code hash).

### Authentication / signature mechanism

- **Report signatures:** CRE Solana encoder = ECDSA (secp256k1) over keccak256 of the report. Verification requires ≥ F+1 valid signatures from the configured DON signer set.
- **KICKR adapter (future):** a new `ExternalAttestorVerifier` behind the Phase 9 interface. It:
  1. parses the CRE report;
  2. verifies the signature quorum against a **pinned** DON signer set from config (`CRE_DON_SIGNERS`, `CRE_DON_F`), or reads the forwarder state account (read-only) and cross-checks it;
  3. decodes claims;
  4. hands off to the *unchanged* Phase 9 checks (match/contest/ruleset/result-hash/stale/replay).

  The existing Ed25519 path is not modified or relaxed. A secp256k1 path is **added** only for an attestor whose `kind` is `CRE_DON`.

### Failure / outage behaviour

- DON or provider outage, or a missing report → `ATTESTATION_MISSING` → settlement cannot advance (fail-closed). No fallback to `LOCAL_DEV` or to KICKR signing in production.
- Insufficient signatures, wrong signer set, or altered payload → `ATTESTATION_SIGNATURE_INVALID`.
- Report `issuedAt` older than the snapshot change, or beyond max age → `ATTESTATION_STALE`.
- Duplicate report / attestationId → `ATTESTATION_REPLAY`.
- Production with the CRE attestor not configured → config load fails (`ATTESTOR_REGISTRY_EMPTY`).

### Cost, accounts, and the config the user must provide

| Item | Requirement |
|---|---|
| Sportmonks | Paid plan covering the contest leagues (from €29/mo Starter, €99 Growth, €249 Pro, Enterprise custom; https://www.sportmonks.com/football-api/plans-pricing/). Token goes into **CRE secrets**, and into KICKR `.env` as `SPORTS_API_KEY` for ingest. Never committed. |
| Chainlink CRE | CRE account + `cre login` + **approved deploy access** (`cre account access`; https://docs.chain.link/cre/account/deploy-access). Onchain registry deployment needs a linked wallet, ETH gas, and an Ethereum RPC (https://docs.chain.link/cre/guides/operations/deploying-to-onchain-registry-ts). Billing/quotas per CRE service terms (https://docs.chain.link/cre/service-quotas). |
| Solana (optional on-chain path) | A **new** receiver program (not `escrow/`) implementing `on_report`, deployed to Devnet. Needs a funded Devnet deployer, which needs explicit approval for Devnet transactions. |
| KICKR config (future) | `EXTERNAL_ATTESTOR_KIND=CRE_DON`, `CRE_WORKFLOW_ID`, `CRE_WORKFLOW_CODE_HASH`, `CRE_DON_SIGNERS` (comma-separated 20-byte addresses), `CRE_DON_F`, `CRE_SOLANA_FORWARDER_PROGRAM=CXsKEJcs25TQEYU2e5jZ8QTPE3ffMLZhH6BWHrdcCCB5`, `CRE_SOLANA_FORWARDER_STATE=8QoomCQyPSkJ8WopJbX9B4HyvrFzziwvJdU8hZE6DCr9` (deployed-Devnet values per the CRE docs), `ATTESTATION_MAX_AGE_SECONDS`. None of these are secrets except the Sportmonks token, which lives only in CRE secrets / `.env`. |

### What remains centralized

- Sportmonks is the single source of truth for match events. A multi-provider median would need a second paid feed (e.g. API-Football).
- Chainlink controls DON membership and CRE deploy approval.
- KICKR authors and deploys the workflow. This is mitigated by publishing and pinning the code hash, but KICKR can still decide *not* to request an attestation (a liveness problem, not a safety one).
- RBAC review/approval stays with KICKR operators. `RUN_SETTLEMENT` is still granted to nobody.

## 6. Why nothing was implemented in Phase 10

A CRE adapter written now could only be tested against signatures we generate ourselves, or against the CLI's **mock** forwarder. That is exactly the "adapter that only works against mocks" the spec forbids presenting as real. The same applies to Switchboard (gateway unreachable, no token, Devnet transactions forbidden), Reclaim and TLSNotary (no independent notary/attestor credentials), and every EVM-only option. So Phase 10 is docs-only, and Phase 9 remains the enforced, fail-closed boundary.

## 7. Invariants confirmed unchanged

- `git diff 16b6347 -- escrow` is empty (program unchanged).
- DEV fee is 1000 bps.
- `RUN_SETTLEMENT` is granted to nobody.
- No backend USDC custody/signer.
- No paid production contests; no India paid entries.
- Phase 9 verifier, registry, and gate are unmodified; `LOCAL_DEV` is still forbidden in production.
