# 59: Fix interchange media-tree Playwright fixtures

**What to build:** Update interchange browser-test API fixtures to satisfy the current media-tree response contract so the complete file passes alongside the new cancellation test.

**Blocked by:** 58

**Category:** bug
**Status:** completed

- [x] All interchange Playwright fixture routes for media-tree responses provide the folders/items shape required by the client.
- [x] `playwright/interchange.spec.ts` passes in full.
- [x] `make check` passes.

## Comments

Opened after the ticket 58 focused browser test passed but two sibling interchange tests timed out because their `/media` fixtures no longer supplied a compatible media-tree response.

- Updated both interchange fixtures to handle `/media/tree` with the required `{ folders, items }` envelope.
- Validation: `make check` passes; the full interchange Playwright file passes.
