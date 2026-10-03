# RBAC

Permissions are explicit. No role is an admin that can do everything. No application role may directly move escrow funds. There is no `MOVE_ESCROW` permission, and `touchesEscrow` is false on every catalog entry.

`RUN_SCORING` does not touch escrow.

`INDEXER_CONFIRM_ENTRY` is a constant for a future program/indexer path only. It is not a row in `permissions`, not on any role, and not on REVIEWER. API and support roles cannot mark an entry confirmed.

REVIEWER is a capability grant (`account_capability_grants`), not a role.

The parenthetical headcounts in the Phase 1 brief are planned staffing, not schema limits. TODO: headcount enforcement is unspecified.

## Groups

| Group | Permissions |
| --- | --- |
| READ | `READ_SYSTEM`, `READ_CONTEST`, `READ_USER_HISTORY`, `READ_AUDIT` |
| OPERATE | `WRITE_SUPPORT_NOTE`, `MANAGE_MATCH_CONFIG`, `MANAGE_CONTEST_CONFIG`, `RUN_SCORING`, `RUN_SETTLEMENT` |
| APPROVE | `REVIEW_RESULT` |
| ADMINISTER | `MANAGE_RBAC`, `MANAGE_SYSTEM` |

TODO: classifying `MANAGE_MATCH_CONFIG` and `MANAGE_CONTEST_CONFIG` as OPERATE rather than ADMINISTER is a grouping choice. It does not add powers beyond the matrix below.

## Matrix

| Principal | Permissions |
| --- | --- |
| CEO_HEAD (headcount 1, not enforced) | `MANAGE_RBAC`, `MANAGE_SYSTEM`, `READ_SYSTEM`, `READ_AUDIT`, `READ_CONTEST` |
| BACKEND_DEVELOPER (1) | `READ_SYSTEM`, `MANAGE_MATCH_CONFIG`, `MANAGE_CONTEST_CONFIG`, `RUN_SCORING` |
| APP_DEVELOPER (2) | `READ_SYSTEM`, `READ_CONTEST` |
| TESTER (1) | `READ_SYSTEM`, `READ_CONTEST` |
| PRODUCT_MANAGER (1) | `READ_SYSTEM`, `READ_CONTEST`, `MANAGE_CONTEST_CONFIG`, `MANAGE_MATCH_CONFIG` |
| UI_UX_DEVELOPER (1) | `READ_SYSTEM` |
| SUPPORT (1) | `READ_USER_HISTORY`, `WRITE_SUPPORT_NOTE`, `READ_CONTEST` |
| REVIEWER capability (not a role) | `REVIEW_RESULT` only |

Not granted to any human role:

- `RUN_SETTLEMENT` (the permission exists; TODO: the holder is unspecified; CEO_HEAD does not execute settlement)
- `REVIEW_RESULT` except via the REVIEWER capability
- `INDEXER_CONFIRM_ENTRY`
- any escrow movement permission

## Hard rules

- SUPPORT cannot administer (`MANAGE_RBAC`, `MANAGE_SYSTEM`), cannot read or write audit, and cannot modify scores, winners, or money.
- BACKEND_DEVELOPER and APP_DEVELOPER cannot `RUN_SETTLEMENT` or `REVIEW_RESULT`.
- UI_UX_DEVELOPER cannot perform sensitive operations. The only permission is `READ_SYSTEM`.
- A scoring permission cannot touch escrow.
- No normal API permission confirms an entry.

## TODO

- Whether a reviewer also needs `READ_CONTEST` (or any read) is unspecified. It is not granted here, because the capability is defined as `REVIEW_RESULT` only.
- `WRITE_SUPPORT_NOTE` has no storage table yet. The permission must not be treated as permission to edit scores, winners, audit, or money.
- No audit event was specified for role changes, so there is no HTTP API that grants roles. Inserts are operational SQL until an audited admin flow exists. That flow is not built in Phase 1.
- `MANAGE_SYSTEM` and `MANAGE_RBAC` have no mutation endpoints in Phase 1.
