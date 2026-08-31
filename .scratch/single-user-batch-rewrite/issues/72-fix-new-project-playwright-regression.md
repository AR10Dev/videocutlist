# 72: Fix new-project Playwright regression

**What to build:** Restore the new-project reset and confirmation browser flow after the save-on-export/query lifecycle changes without weakening unsaved-change protection.

**Blocked by:** 70

**Category:** bug
**Status:** wontfix

- [x] `new projects reset the editor and dirty changes need confirmation` passes.
- [x] New project clears old media/project/job state and restores revision-zero editor state.
- [x] Unsaved changes still require confirmation before replacement.
- [x] Relevant segment-selection Playwright coverage and `make check` pass.

## Comments

- Split from ticket 70.
- Commit `0fa5657` updated the browser assertion for the current onboarding state; ticket 73 completed the final integrated browser validation.
- Retained as `wontfix` because the implementation is complete. Validation: full segment-selection Playwright passes (30 tests) and `make check` passes.
