# Public DEMO mode

KICKR can run a **public demo** on fictional sports data. This is **not** Sportmonks and **not** real-world fixtures.

## Configure

Authoritative env var: **`SPORTS_PROVIDER`**.

| Value | Meaning | Production |
| --- | --- | --- |
| `DEMO` | Fictional clubs/players, realistic upcoming → live → final schedules. Labeled **DEMO DATA**. | Allowed for demo deployments |
| `SPORTMONKS` | Live Sportmonks Football API v3 (requires `SPORTS_API_KEY`) | Allowed |
| `LOCAL_DEV` | Developer catalog only | **Refused** (fail closed) |
| `none` / unset | No provider | **Refused** in production |

Production **must** set `SPORTS_PROVIDER=DEMO` or `SPORTS_PROVIDER=SPORTMONKS` explicitly. There is **no silent fallback**.

Legacy `SPORTS_DATA_PROVIDER=local-dev` still works on developer machines when `SPORTS_PROVIDER` is `none`, and is refused in production.

```bash
# Production demo example (env names only — put values in a secret store)
NODE_ENV=production
SPORTS_PROVIDER=DEMO
DEMO_SEED_ENABLED=true          # only when deliberately seeding; then set false
DEMO_CONTROL_TOKEN=             # ≥16 chars to enable /v1/demo/control/* ; leave empty to disable
APPROVED_ATTESTORS=             # ID:hexPublicKey (non-LOCAL_DEV); paid settlement still fail-closed
ALLOWED_ORIGINS=https://your.host
AUTH_DOMAIN=your.host
# DATABASE_URL, REDIS_URL, SOLANA_RPC_URL, ESCROW_PROGRAM_ID, USDC_MINT, SESSION_TTL_SECONDS
# Do NOT set LOCAL_DEV. Do NOT set escrow/signer private keys. Do NOT grant RUN_SETTLEMENT.
```

## Seed

```bash
npm run demo:seed
```

Requires `SPORTS_PROVIDER=DEMO`. In production, also set `DEMO_SEED_ENABLED=true`.

Creates/updates DEMO matches, players, and **FREE** contests only. Never creates paid contests, touches escrow, sends Solana transactions, or grants `RUN_SETTLEMENT`.

## Readiness

```bash
npm run demo:ready
# optional live probe:
BASE_URL=http://127.0.0.1:3000 npm run demo:ready
```

HTTP: `GET /ready/demo` — fails closed if LOCAL_DEV is active, paid production paths are open, DB/Redis unhealthy, or a custody/dev-signer env is present.

## Demo match control (ops / token-gated)

Completely disabled unless **`SPORTS_PROVIDER=DEMO`** and **`DEMO_CONTROL_TOKEN`** (≥16 characters) is set. Sportmonks production cannot enable this path. Present header `x-demo-control-token`.

| Method | Path | Effect |
| --- | --- | --- |
| GET | `/v1/demo/control/status` | Whether control is enabled (no token required) |
| POST | `/v1/demo/control/matches/:id/advance` | Body `{ "until": "LIVE" \| "FINAL" \| ... }` or `{ "to": "LOCKED" }` |
| POST | `/v1/demo/control/matches/:id/score` | Rebuild live scores from stored events |
| POST | `/v1/demo/control/matches/:id/scoring-wave` | Inject deterministic late DEMO events + rebuild |
| POST | `/v1/demo/control/matches/:id/finalize-free` | Finalize FREE contest results after FINAL (no settlement) |

All mutating calls are audited (`DEMO_MATCH_ADVANCED`, `DEMO_SCORING_WAVE`, `DEMO_SCORE_REBUILD`, `DEMO_FREE_FINALIZE`). **Never** grants `RUN_SETTLEMENT`. Not exposed in the consumer player UI.

## Labels

Match competition and `dataSource.label` say **DEMO DATA** / **DEMO Cup**. Clients see `public.demoData=true` from `/v1/config/public`. The SPA shows a concise **DEMO DATA** banner.

## Redeploy

- **Fly.io**: `fly deploy` with secrets from `deploy/README.md` / `fly.toml`.
- **Compose**: `docker compose -f docker-compose.demo.yml up --build -d`.
- After deploy: migrate → optional `DEMO_SEED_ENABLED=true npm run demo:seed` → `BASE_URL=https://… npm run demo:ready` → set `DEMO_SEED_ENABLED=false`.

## Public URL

Document the live HTTPS URL here when deployed:

- **Public demo URL:** _Not yet on a durable public host from this environment._
  - Local production-demo stack passes `GET /ready/demo` at `http://127.0.0.1:3000`.
  - Cloudflare quick tunnel was attempted but the sandbox cannot complete the tunnel handshake to Cloudflare edge (QUIC timeout / HTTP 530).
  - Fly.io / Railway / Render need an authenticated account (`fly auth login` etc.); no deploy token was available.
  - Deploy configs are ready: `Dockerfile`, `docker-compose.demo.yml`, `fly.toml`, `deploy/README.md`.
- Redeploy: see `deploy/README.md`. After a real host is up, set `ALLOWED_ORIGINS` / `AUTH_DOMAIN` to that origin and re-run `BASE_URL=https://… npm run demo:ready`.
