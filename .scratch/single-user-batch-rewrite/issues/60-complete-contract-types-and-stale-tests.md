# 60: Complete generated contract types and stale-response tests

**What to build:** Eliminate remaining handwritten server response models in favor of generated OpenAPI schemas, replace static stale-ID coverage with a real query/App race assertion, and reconcile incomplete ticket tracking.

**Blocked by:** 59

**Category:** bug
**Status:** completed

- [x] Contract-backed project, media, destination, and export-job response models use generated OpenAPI schemas; endpoints without schemas retain local transport shapes.
- [x] A test creates an actual delayed query race and proves it cannot overwrite newer selection state.
- [x] Ticket 57 status/checklist is reconciled to the implementation evidence, and ticket 58 records the mounted test.
- [x] Ticket 50 status/checklist accurately reflects the generated-contract migration.
- [x] `make check` and the complete interchange Playwright file pass.

## Comments

Opened from the final review of tickets 50–59. Replaced static stale-ID coverage with a delayed keyed QueryClient race test and reconciled ticket 57. Validation: client tests pass; the complete interchange Playwright file passes on ticket 59.
