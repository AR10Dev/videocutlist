# 65: Fix full Playwright fixtures and ticket tracking

**What to build:** Update all browser fixtures for the current media-tree/settings UI contracts and accurately close the originating frontend ticket after complete validation.

**Blocked by:** 64

**Category:** bug
**Status:** needs-review

- [x] Every Playwright media-tree fixture uses the current folder-page envelope.
- [ ] Full Playwright passes, including segment-selection and interchange coverage.
- [x] Ticket 11 status, checkboxes, and comments accurately record that full Playwright remains unresolved.
- [x] Ticket 64 removes its false ticket-11 reconciliation claim until this ticket completes.
- [x] `make check` passes.

## Comments

Updated segment-selection fixtures from the obsolete `/media` list envelope to the current `/media/tree` folder-page envelope and reconciled ticket 11/64 tracking. Validation: `make check` passes; full Playwright still has unrelated pre-existing segment-selection failures and remains for review.

## Comments

Opened after full Playwright on ticket 64 exposed stale segment-selection fixtures and showed that ticket 11 had not been updated despite ticket 64 claiming it had.
