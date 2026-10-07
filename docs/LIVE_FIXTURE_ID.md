# Changing LIVE_FIXTURE_ID (ops)

Public LIVE mode always exposes **exactly one** Sportmonks fixture: `LIVE_FIXTURE_ID`.
Do **not** hardcode a fixture id in application code. Change it via environment only.

## Prerequisites

- `APP_MODE=LIVE` or `APP_MODE=DUAL`
- `SPORTS_API_KEY` set on the server (never in the browser, public config, or logs)
- Solana remains **DEVNET only**; public LIVE contests remain **FREE**

## Pick a fixture

1. Query Sportmonks for an upcoming or in-play football fixture (server-side only), e.g. fixtures between today and +7 days, or livescores in-play.
2. Note the numeric fixture id (example shape: `19722776`) and confirm clubs/kickoff/state look right.
3. Prefer an upcoming or live match. A recently finished match is acceptable for smoke tests if nothing upcoming is fetchable.

## Render dashboard

1. Open the `kickr-demo` web service → **Environment**.
2. Set `LIVE_FIXTURE_ID` to the new id (string digits only).
3. Keep `APP_MODE=DUAL` (or `LIVE`) and `SPORTS_API_KEY` unchanged.
4. Save. On the free plan this typically **redeploys** the service.
5. After deploy: open https://kickr-demo.onrender.com → switch to **LIVE** → confirm one match (clubs / kickoff / state) and **LIVE DATA** banner.
6. Switch to **DEMO** and confirm the fictional match is unchanged (datasets never mix).

## Render MCP / API

From an authorized agent session (workspace selected):

```text
update_environment_variables
  serviceId: srv-db2ininlk1mc73cbdmm0
  envVars: [{ key: "LIVE_FIXTURE_ID", value: "<new-id>" }]
  replace: false
```

Then `trigger_deploy` for that service if auto-deploy does not pick up env-only changes.

## Render CLI

```bash
render env set LIVE_FIXTURE_ID=<new-id> --service srv-db2ininlk1mc73cbdmm0
render deploys create --service srv-db2ininlk1mc73cbdmm0
```

## After change

- Worker bootstraps the new fixture into Postgres (clubs/players/squad) on startup.
- Adaptive poller: PREMATCH 60s, INPLAY 10s, HT/BREAK 30s, FINAL stops high-frequency.
- Postgres remains authoritative; Redis is cache-only (survives Redis reset / duplicate polls).
- If Sportmonks is unavailable or rate-limited, the UI must show an error state — **never** fall back to DEMO data while in LIVE mode.

## Dual-mode note

With `APP_MODE=DUAL`, one process serves both datasets. The client sends `?mode=LIVE|DEMO` or `X-KICKR-Mode`. Changing `LIVE_FIXTURE_ID` only affects LIVE; DEMO stays on the fictional single match.
