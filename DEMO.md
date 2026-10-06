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
# Production demo example
NODE_ENV=production
SPORTS_PROVIDER=DEMO
DEMO_SEED_ENABLED=true   # only when deliberately seeding
# Do NOT set LOCAL_DEV. Do NOT set escrow/signer private keys.
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

## Labels

Match competition and `dataSource.label` say **DEMO DATA** / **DEMO Cup**. Clients see `public.demoData=true` from `/v1/config/public`.
