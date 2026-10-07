# Phase 18D.2 Match Operations

Private operator surface for managing match data when a paid sports API is unavailable.

## Access

- Route UI: `/ops/matches` (never linked from consumer navigation)
- API: `/v1/ops/match-ops/*`
- Permission: `MANAGE_MATCH_OPERATIONS`
- Granted to: **CEO_HEAD**, **BACKEND_DEVELOPER**
- Not granted to: Support, UI/UX, Product

## Provenance (never mix)

| Source | Label | Manual scoring |
| --- | --- | --- |
| Sportmonks | LIVE / Sportmonks authoritative | Forbidden |
| Operator | `OPERATOR_MANAGED` | Allowed (confirmed events only) |
| Tutorial | `SIMULATED` | Tutorial simulator only |

## Event flow

operator / Grok proposal (`PROPOSED` → `REVIEWED`) → human `CONFIRMED` → `match_events` → LIVE_V1 → score snapshots → contest leaderboard → user UI

Grok suggestions never mutate scores directly. Provenance on published events: `MANUAL_OPERATOR` or `GROK_PROPOSED_MANUAL_CONFIRMED`.

## Corrections

Append-only. Never edit/delete historical scoring events. Correction references original → recompute → leaderboard update.

## Credits

Validated range 1–20. Immutable credit audit (previous, new, actor, reason, timestamp). Applies to future XI selections only — frozen `fantasy_team_versions` are never rewritten.
