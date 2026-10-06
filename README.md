# KICKR

**KICKR** is a Solana-native fantasy football contest platform. Players build an XI, join contests, and climb live leaderboards as match events score their teams.

## Current FREE product (public demo)

The public demo is **FREE-only**:

- Build and save an XI for a DEMO Cup match (fictional clubs/players).
- Join **FREE** contests (Head-to-Head and Grand League templates).
- Create **private FREE leagues**, share invite codes, and compete with friends.
- Watch live leaderboards update as demo match events arrive; view final results and profile stats.
- Share result pages with **1200×630 OG images**.

**Paid production contests are disabled.** There is no India paid-entry path. Backend never custodies user USDC. `RUN_SETTLEMENT` is granted to **nobody**.

## Architecture (short)

| Layer | Role |
| --- | --- |
| Postgres | Authoritative for accounts, sessions, RBAC, football catalog, contests, audit |
| Redis | Non-authoritative cache (leaderboards, discovery) — never money |
| API (`api/`) | Hono HTTP API + serves built SPA from `dist/client` |
| Sports provider | `SPORTS_PROVIDER=DEMO` (fictional) or `SPORTMONKS` (live API). `LOCAL_DEV` refused in production |
| Solana escrow | Devnet prototype in `escrow/` — deposits/claims exist; production paid contests off |
| Attestation | Independent result attestation boundary; production requires non-LOCAL_DEV attestor public keys. External real-world attestor **not yet connected** |

See `ARCHITECTURE.md`, `SECURITY.md`, `RBAC.md`, `FOOTBALL.md`, `CONTESTS.md`, `ESCROW.md`, `DEMO.md`.

## Scoring flow

1. Match events are stored append-only (DEMO catalog or Sportmonks ingest).
2. Live scoring pipeline recomputes player → team → contest entry milli-points (DEV_V1 ruleset).
3. Redis caches leaderboards keyed by score snapshot; a new wave invalidates cache.
4. FREE contests finalize to a durable free-result snapshot (rank + score only — no USDC, no settlement).

## Private leagues

Invite-only FREE leagues: create → share invite code/link → friends join with their XI → league leaderboard tracks the same match scoring. No entry fee, no prize pool, no settlement.

## Solana escrow prototype

`escrow/programs/kickr_escrow` is a **devnet** program: user-wallet `deposit`, vault ATA, claim/refund paths. Fee is **DEV configuration at 1000 bps (10%)** — not a production fee commitment. Mainnet mint and paid production contests are refused.

## Independent attestation boundary

Settlement (when enabled later) requires an approved external attestor signature over the result snapshot. The backend does **not** sign attestations in production. `LOCAL_DEV` attestor is refused in production. Today the registry holds configured public keys for fail-closed gates; a live external attestor integration is future work.

## Public demo

```bash
# Configure production-demo (see DEMO.md / .env.example)
NODE_ENV=production
SPORTS_PROVIDER=DEMO
# …DATABASE_URL, REDIS_URL, ALLOWED_ORIGINS, APPROVED_ATTESTORS, etc.

npm run build
npm run db:migrate
DEMO_SEED_ENABLED=true npm run demo:seed
npm run demo:ready          # or BASE_URL=https://your.host npm run demo:ready
```

Demo match progression for operators (not player UI):

```bash
# Requires DEMO_CONTROL_TOKEN (≥16 chars) and header x-demo-control-token
curl -X POST "$BASE/v1/demo/control/matches/$MATCH_ID/advance" \
  -H "x-demo-control-token: $DEMO_CONTROL_TOKEN" -H 'content-type: application/json' \
  -d '{"until":"LIVE"}'
```

Deploy configs: `Dockerfile`, `docker-compose.demo.yml`, `fly.toml`, `deploy/README.md`.

## Current limitations (explicit)

- **DEMO sports data is fictional** — not Sportmonks, not real-world fixtures.
- **Paid production contests disabled**; paid Devnet templates only outside production.
- **10% / 1000 bps fee is DEV configuration only**, not a production fee.
- **External real-world attestor not yet connected**.
- **No backend USDC custody**; no `RUN_SETTLEMENT` grants.
- Settlement/payout of paid contests is not a public-demo feature.

## Develop

```bash
docker compose up -d          # local Postgres + Redis
cp .env.example .env          # development defaults
npm install
npm run db:migrate
npm run build && npm start    # or npm run dev
npm test
npm run test:pg
```

Push only as the repo owner account configured for this tree (`rishu4436`).
