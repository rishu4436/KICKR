# Football domain (Phase 2)

Phase 2 adds matches, squads, fantasy XIs, and a development scoring engine. It does not add contests, USDC, escrow, payouts, or a live sports feed.

The escrow program still does not exist.

USDC leaves a contest escrow only through a program instruction whose inputs were already written to the entry table and the approved snapshot. The backend decides the list. The program makes the list true. Support can show both records. Support cannot replace either one.

Credits on a squad are an integer selection budget. They are not USDC and they are not a wallet balance.

## Models

Internal UUIDs are the primary keys. Provider ids are references only.

- Club, player, and player role (`GK`, `DEF`, `MID`, `FWD`)
- Match: home, away, kickoff, competition, venue, external fixture id, status, lineup availability, data-source metadata
- Match squad: fantasy position, integer credit, availability, starting status, squad status, provider id, source version, sourced-at
- Fantasy team: `DRAFT` or `LOCKED` for one account and one match
- Fantasy team version: append-only XI, captain, vice, credits used, validation result. The latest version is a convenience read. History is not edited.
- Scoring ruleset, including DEV_V1
- Immutable match events. A correction is a new row with `supersedes_event_id`.

Postgres migration: `migrations/002_phase2_football_domain.sql`. Migration 001 is unchanged.

## Match edges

Normal: `SCHEDULED → LINEUPS_AVAILABLE → LOCKED → LIVE → HALFTIME → LIVE → FULL_TIME → DATA_FINALIZING → FINAL`.

Also explicit: `SCHEDULED → POSTPONED`, `SCHEDULED → CANCELLED`, `LIVE → ABANDONED`, `DATA_FINALIZING → VOID`.

There is no raw status setter. `transition("MATCH", from, to)` is the only write path used by the store.

Fantasy team: `DRAFT → LOCKED` only. Saving a version of a locked team is rejected. Kickoff does not auto-lock yet.

## XI rules

`validateFantasyTeam` is pure. The API runs it again on save. The builder uses the same function for feedback.

- exactly 11
- exactly 1 GK, 3–5 DEF, 3–5 MID, 1–3 FWD
- no duplicates
- every player is on that match's included official squad
- integer credits, total `<=` `FANTASY_CREDIT_CAP`
- captain and vice are in the XI and are different
- the XI uses both clubs in the fixture

`FANTASY_MAX_PLAYERS_FROM_ONE_TEAM` is null in dev. A stricter per-club number is not invented. TODO: the production cap and the per-club max are unspecified. The default cap of 100 is a development knob.

A new version is allowed only while the match is `SCHEDULED` or `LINEUPS_AVAILABLE` and lineups are available. TODO: the exact kickoff cutoff is otherwise unspecified.

`TEAM_SAVED` is appended through the Phase 1 audit log.

## DEV_V1

Not a production contract. Status `DEVELOPMENT`. Scale is milli-points (`1000` = 1 displayed point). Multipliers apply once to a player's summed base, using integer division toward zero.

| Event | Milli-points |
| --- | --- |
| GOAL | 5000 |
| ASSIST | 3000 |
| SHOT | 0 |
| SHOT_ON_TARGET | 1000 |
| KEY_PASS | 0 |
| TACKLE | 0 |
| INTERCEPTION | 0 |
| CLEARANCE | 0 |
| SAVE | 0 |
| CORNER_WON | 1000 |
| FOUL_COMMITTED | 0 |
| YELLOW_CARD | -1000 |
| RED_CARD | 0 |
| OWN_GOAL | 0 |
| SUBSTITUTION | 0 |
| PENALTY_MISS | 0 |
| PENALTY_SAVE | 0 |
| GOAL_CONCEDED | 0 |
| VAR_REVERSAL | 0 |

Captain multiplier `2/1`. Vice multiplier `3/2`. Rounding policy `TOWARD_ZERO`. Only `primary_player_id` is scored. TODO: whether the secondary player also scores is unspecified.

## API

Authenticated. No join or payment routes.

- `GET /matches`
- `GET /matches/:id`
- `GET /matches/:id/players`
- `GET /matches/:id/squad`
- `POST /teams`
- `GET /teams/:id`
- `GET /teams/:id/versions`
- `POST /teams/:id/versions`

The UI is served at `/` after `npm run build` (hash routes `#/`, `#/matches/:id`, `#/matches/:id/xi`).

## Sports data

`SportsDataProvider` has `listMatches`, `getMatch`, `getSquad`, and `getEvents`. `local-dev` is a fixed fictional catalog. `unset` loads nothing. A real provider is not implemented and can be added behind the same port.


## Phase 5 live scoring

See `docs/LIVE_SCORING.md`. Canonical events remain in `match_events` (append-only). New columns: `correction_type`, `provider_version`, `raw_event_hash`. External ids map through `provider_id_map` plus existing `provider_id` / `external_fixture_id` columns.

Added routes (authenticated):

- `GET /matches/:id/live`
- `GET /matches/:id/events`
- `GET /matches/:id/leaderboard`
- `GET /teams/:id/live-score`
- `GET /matches/:id/live-stream` (SSE)
- `GET /v1/diagnostics/live` (`READ_SYSTEM`)

DEV_V1 remains `DEVELOPMENT`. It is not the production ruleset.
