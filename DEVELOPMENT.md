# Development

## Local setup

Requirements: Node.js 20 or newer, npm. Postgres 16 and Redis 7 are needed only when you run the API or migrations. Unit tests do not start either service.

```bash
cp .env.example .env
docker compose up -d
npm install
npm run db:migrate
npm run dev
```

`.env.example` holds local placeholders. Do not commit `.env`. Do not put a key that can move USDC in the environment. No such variable exists.

`DATABASE_URL`, `REDIS_URL`, and `AUTH_DOMAIN` are required. Other values have defaults so local development does not need production secrets. Solana RPC and sports data are placeholders. Phase 1 does not call them.

The migration runner expects the process working directory to be the repository root, where `migrations/` lives.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest. No live Postgres or Redis. |
| `cd escrow && anchor test --skip-deploy` | LiteSVM program tests. Not run by GitHub Actions. |
| `npm run build` | Compile to `dist/` |
| `npm run dev` | API via tsx |
| `npm run db:migrate` | Apply SQL migrations |
| `npm start` | Run compiled `dist/api/main.js` |

GitHub Actions (`.github/workflows/ci.yml`) runs lint, typecheck, test, and build. It does not start Postgres or Redis and it does not install Anchor. Run `cd escrow && anchor test --skip-deploy` locally before a Phase 4 push. See `DEVNET.md`.

## Auth in local tests

Tests generate a tweetnacl keypair, request a nonce, sign the exact message, and call login. They inject a clock, so expiry does not sleep.

## Production errors

Set `NODE_ENV=production` for generic 500 messages. Stack traces are not included in HTTP bodies in any environment.

## Phase boundary

Do not add escrow instructions, USDC transfers, scoring, sports ingestion, settlement, or payout code to this phase. Add a documented TODO when a business rule is still undefined.


## Phase 2 UI

`npm run build` compiles the API and the Vite client into `dist/client`. `npm start` or `npm run dev` serves `/` from that folder when it exists. Set `SPORTS_DATA_PROVIDER=local-dev` and run migrations through `002` to load the fictional catalog. Sign-in on the page uses a development keypair, not a production wallet.
