# 74: Align interchange tests with save-on-export

**What to build:** Update interchange browser fixtures and assertions for the approved save-on-export flow and current collapsed/visible project controls, without reducing behavioral coverage.

**Blocked by:** 69, 73

**Category:** bug
**Status:** completed

- [x] Interchange cancellation test reaches the project save/export controls under the current UI layout.
- [x] Interchange persistence tests assert the current visibility and enabled/disabled behavior under save-on-export.
- [x] Full interchange Playwright passes.
- [x] `make check` passes.

## Comments

Opened after tickets 67–73 brought full Playwright to 40/43 passing; all three remaining failures were in interchange tests with outdated details-summary toggles. Tests now preserve the default-open project details section while validating save-on-export behavior.

- Validation: `pnpm --dir client exec playwright test playwright/interchange.spec.ts` passes (4 tests).
