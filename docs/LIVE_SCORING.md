# Phase 5 live scoring

## Provider choice

**Sportmonks Football API v3**

- Docs: https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/livescores/get-inplay-livescores
- Event types: https://docs.sportmonks.com/v3/definitions/types/events
- Base URL: `https://api.sportmonks.com/v3`
- Auth: `api_token` query parameter (or header)
- Live path: `GET /football/livescores/inplay?include=participants;scores;events;timeline;lineups;state`
- Why: documented near-live fixtures/events API, free tier for hackathon use, stable fixture/player ids, goals/cards/subs/VAR/timeline shots & corners. Not selected merely for historical popularity.

## Configuration

| Env | Purpose |
| --- | --- |
| `SPORTS_DATA_PROVIDER` | Phase 2 catalog: `local-dev` \| `unset` |
| `SPORTS_PROVIDER` | Live adapter: `sportmonks` \| `none` |
| `SPORTS_API_KEY` | Sportmonks token. Missing ⇒ fail closed |
| `SPORTS_API_URL` | Default `https://api.sportmonks.com/v3` |
| `SPORTS_POLL_INTERVAL` | Seconds between polls (default 15) |
| `SPORTS_REQUEST_TIMEOUT_MS` | Per-request timeout (default 8000) |

`LIVE_PROVIDER_CONFIGURED` is exposed on `/health`, `/ready`, and `GET /v1/diagnostics/live` (requires `READ_SYSTEM`). It is `true` only when `SPORTS_PROVIDER=sportmonks` and `SPORTS_API_KEY` is set. There is no silent fallback to fake production data.

## Pipeline

provider response → validate/normalize → dedupe (`provider` + `provider_event_id`) → append-only `match_events` → DEV_V1 recompute from log → Redis live cache → REST + SSE → UI

Postgres/event log remains authoritative. Redis is cache-only and rebuildable.
