# Deploying KICKR (public DEMO)

Prefer a real HTTPS host (Fly.io, Railway, Render). Compose + tunnel is a fallback.

## Required env names (no secret values here)

| Name | Notes |
| --- | --- |
| `NODE_ENV` | `production` |
| `SPORTS_PROVIDER` | `DEMO` |
| `DATABASE_URL` | Postgres |
| `REDIS_URL` | Redis |
| `AUTH_DOMAIN` | Public hostname (no scheme) |
| `ALLOWED_ORIGINS` | Exact public origin(s), no wildcards |
| `APPROVED_ATTESTORS` | Non-LOCAL_DEV public key(s); paid settlement still fail-closed |
| `SOLANA_RPC_URL` | Devnet RPC |
| `ESCROW_PROGRAM_ID` | Public program id |
| `USDC_MINT` | Devnet mint placeholder |
| `SESSION_TTL_SECONDS` | ≥ 60 |
| `DEMO_SEED_ENABLED` | `true` only while seeding, then off |
| `DEMO_CONTROL_TOKEN` | ≥16 chars; enables `/v1/demo/control/*` |
| Never set | `LOCAL_DEV`, custody/signer private keys, `RUN_SETTLEMENT` grants |

## Fly.io

```bash
fly launch --no-deploy   # or use existing fly.toml
fly postgres create      # or attach managed Postgres
fly redis create         # or external Redis
fly secrets set DATABASE_URL=... REDIS_URL=... APPROVED_ATTESTORS=... ALLOWED_ORIGINS=https://... AUTH_DOMAIN=... USDC_MINT=... DEMO_CONTROL_TOKEN=...
fly deploy
# one-shot seed:
fly ssh console -C 'DEMO_SEED_ENABLED=true node ...'   # or run npm run demo:seed from CI with secrets
```

## Docker Compose (local / VPS)

```bash
cp .env.example .env.demo   # fill production-demo values
docker compose -f docker-compose.demo.yml up --build -d
# migrate + seed from a one-shot container or host with DATABASE_URL pointed at the stack
```

## Readiness

`GET /ready/demo` and `npm run demo:ready` with `BASE_URL=https://your-host` must pass.
