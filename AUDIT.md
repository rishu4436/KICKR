# Audit

`audit_events` is append-only.

## Fields

- actor account id, when there is one (nullable for a future system actor)
- actor wallet, when there is one
- action (event name)
- `occurred_at`
- entity type
- entity id
- `metadata` JSON object
- correlation / request id, when the caller has one
- `created_at`

There is no `updated_at`. Rows are not updated.

TODO: the required metadata *keys* for each event are unspecified. The field must be present and must be a JSON object.

## How it is enforced

Application:

- `AuditStore` exposes `append` and `list` only.
- `updateAuditEvent()` and `deleteAuditEvent()` always throw `AUDIT_APPEND_ONLY`.
- HTTP has `GET /v1/audit/events` for callers with `READ_AUDIT`. There is no PATCH, PUT, or DELETE route.

Database (`migrations/001_phase1_identity_rbac_audit.sql`):

- `BEFORE UPDATE` and `BEFORE DELETE` triggers raise `audit_events is append-only`.
- `REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC`.
- A check constraint limits `action` to the event constants.
- `metadata` must be a JSON object.

The table owner should still be treated as bound by the trigger. TODO: a dedicated non-owner database role with `INSERT` and `SELECT` only is not provisioned in Phase 1.

Phase 1 writes only `ACCOUNT_LOGIN` and `ACCOUNT_LOGOUT`. The other names are constants so later phases do not invent a parallel vocabulary. Writing them from contest, scoring, or settlement code is out of scope here.

## Event constants

`ACCOUNT_LOGIN`, `ACCOUNT_LOGOUT`, `TEAM_SAVED`, `JOIN_QUOTED`, `ENTRY_CONFIRMED`, `ENTRY_REFUNDED`, `CONTEST_LOCKED`, `SCORE_RECOMPUTED`, `REVIEW_APPROVED`, `REVIEW_REJECTED`, `SETTLEMENT_SUBMITTED`, `PAYOUT_CLAIMED`, `CONTEST_REFUNDED`.

SUPPORT does not have `READ_AUDIT` and has no permission that updates or deletes audit rows. Nobody does: update and delete are not permissions.
