# Phase 5 / 18C live scoring

## Provider choice

**Sportmonks Football API v3**

- Docs: https://docs.sportmonks.com/v3/endpoints-and-entities/endpoints/livescores/get-inplay-livescores
- Event types: https://docs.sportmonks.com/v3/definitions/types/events
- Base URL: `https://api.sportmonks.com/v3`
- Auth: `api_token` query parameter (server-side only — never lands in browser bundles)
- Live path: `GET /football/fixtures/{LIVE_FIXTURE_ID}?include=participants;scores;events;timeline;lineups.details.type;state;periods`
- Why: documented near-live fixtures/events API, free tier for hackathon use, stable fixture/player ids, goals/cards/subs/VAR/timeline + lineup detail statistics (shots on target). Not selected merely for historical popularity.

## Modes (Phase 18C)

| `APP_MODE` | Behavior |
| --- | --- |
| `LIVE` | Exactly one `LIVE_FIXTURE_ID`. Real Sportmonks match. UI shows **LIVE DATA**. Requires `SPORTS_API_KEY`. Never falls back to DEMO. |
| `DEMO` | Exactly one fictional match. UI shows **DEMO DATA**. Refuses `LIVE_FIXTURE_ID` / Sportmonks. |
| *(unset)* | Legacy `SPORTS_PROVIDER` behavior for local/tests. |

Misconfiguration fails visibly at config load — no silent LIVE↔DEMO fallback.

## Configuration

| Env | Purpose |
| --- | --- |
| `APP_MODE` | `LIVE` \| `DEMO` (Phase 18C) |
| `LIVE_FIXTURE_ID` | Required when `APP_MODE=LIVE` — exactly one Sportmonks fixture id |
| `SPORTS_DATA_PROVIDER` | Phase 2 catalog: `local-dev` \| `unset` |
| `SPORTS_PROVIDER` | Live adapter: `sportmonks` \| `demo` \| `none` (forced by `APP_MODE` when set) |
| `SPORTS_API_KEY` | Sportmonks token. Missing ⇒ fail closed |
| `SPORTS_API_URL` | Default `https://api.sportmonks.com/v3` |
| `SPORTS_POLL_INTERVAL` | Fallback seconds between polls (default 15). Adaptive schedule overrides when state known. |
| `SPORTS_REQUEST_TIMEOUT_MS` | Per-request timeout (default 8000) |

`LIVE_PROVIDER_CONFIGURED` is exposed on `/health`, `/ready`, and `GET /v1/diagnostics/live` (requires `READ_SYSTEM`). It is `true` only when Sportmonks is selected and `SPORTS_API_KEY` is set. There is no silent fallback to fake production data.

## Scoring rulesets

| Ruleset | Notes |
| --- | --- |
| `DEV_V1` | Historical development ruleset. **Do not mutate.** Includes `CORNER_WON +1`. |
| `LIVE_V1` | Phase 18C live ruleset. GOAL +5, ASSIST +3, SHOT_ON_TARGET +1, YELLOW_CARD −1. **CORNER_WON removed (0).** Captain 2×, Vice 1.5×. |

Sportmonks / `APP_MODE=LIVE` uses `LIVE_V1`. Replay/local-dev tests keep `DEV_V1`.

## Adaptive polling

| Provider state | Interval |
| --- | --- |
| INPLAY (1st/2nd/ET/pens) | 10s |
| HT / breaks | 30s |
| Prematch (NS/TBA) | 60s |
| Final (FT and terminal) | Stop high-frequency polling |

Respect Sportmonks rate limits (429 ⇒ longer backoff).

## Pipeline

provider response → validate/normalize (sort_order) → dedupe (`provider` + `provider_event_id`) → append-only `match_events` → ruleset recompute from log → score snapshots → contest-scoped leaderboard → Redis live cache → REST + SSE → UI

Postgres/event log remains authoritative. Redis is cache-only and rebuildable.

### Shot-on-target synthesis

Sportmonks lineup detail `type_id=86` (`shots-on-target`) is cumulative. Durable state lives in `player_stat_observations` (`fixture_id`, `player_id`, `stat_type`, `observed_total`). When the total increases, synthetic `SHOT_ON_TARGET` events are appended with deterministic ids:

`SHA256(fixture_id + player_id + "SHOT_ON_TARGET" + ordinal)`

Downward corrections (e.g. 3→2) append an explicit correction/reversal referencing ordinal 3 — historical events are never deleted.

### VAR / corrections

Append-only. Goal disallowed (`VAR_REVERSAL` / subtype Goal Disallowed) supersedes the original goal **and** derived assist via the existing correction model. Do **not** rely on the Sportmonks `rescinded` boolean. Recompute scores deterministically afterward.

### Event mapping (provider type_id → KICKR)

| Sportmonks | KICKR |
| --- | --- |
| 14 / 16 (goal / penalty scored) | GOAL (+ derived ASSIST from `related_player_id`) |
| 15 | OWN_GOAL |
| 17 | PENALTY_MISS |
| 18 | SUBSTITUTION |
| 19 | YELLOW_CARD |
| 20 / 21 | RED_CARD |
| 10 / 1697 / subtype 1512 | VAR_REVERSAL |
| 126 | CORNER_WON (weight 0 under LIVE_V1) |
| 569 / synth from detail 86 | SHOT_ON_TARGET |
| 570 | SHOT |

Position map: 24→GK, 25→DEF, 26→MID, 27→FWD. Unsupported mappings fail visibly.

## Phase 5.1 correctness

- Production `provider_id_map` rows are loaded from Postgres at API startup.
- Contest live scores / leaderboards resolve `contest_entries.team_version_id` exactly.
- SSE contribution = event base × captain/vice multiplier (not accumulated player total).
- Sportmonks lineups sync into `match_squad` when mapped; unresolved lineup players are diagnostics only.
- Freshness uses last successful poll / ingest lag, not kickoff age. Occurrence timestamps use provider time or documented `kickoff + minute` fallback.
- VAR/corrections require an explicit related provider event id to supersede; otherwise the correction fact is stored unresolved.
- Approved result snapshots are the Phase 6 settlement input boundary. Settlement stays blocked without an approved external attestor (Phase 9). Sportmonks responses are **not** independent attestations.
- Solana remains **DEVNET only**. Public LIVE contests remain FREE. No backend USDC custody.
- Rights: no Sportmonks logos/player photos — KICKR crest/avatar fallbacks only.
