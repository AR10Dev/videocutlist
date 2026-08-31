# 61: Finish settings contract and UI race coverage

**What to build:** Complete generated settings-response typing, make tracker evidence truthful, and extend browser coverage to prove discarded export and media responses cannot restore stale UI state.

**Blocked by:** 60

**Category:** bug
**Status:** completed

- [x] Settings responses use generated `SettingsResponse` for all contract-backed fields; only unschematized endpoint payloads remain local with documented reason.
- [x] Ticket 57 and ticket 58 statuses/comments/checklists accurately reflect validated acceptance evidence.
- [x] Browser cancellation test asserts that old export status and cancel controls do not reappear after the late DELETE response.
- [x] Browser test defers selected-media metadata, changes selection, releases the old response, and proves the new selection persists.
- [x] `make check` and the full interchange Playwright file pass.

## Comments

Opened from the tickets 50–60 final review. Updated settings responses to use the generated OpenAPI envelope and extended the mounted cancellation test with delayed metadata and stale UI assertions. Validation: full interchange Playwright file and `make check` pass.
