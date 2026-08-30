# 69: Decide dirty export and preflight lifecycle

**What to build:** Define and implement the intended export action semantics when the editor has unsaved changes: either require an explicit save before export or save first and then run a fresh preflight before submission.

**Blocked by:** 68

**Category:** enhancement
**Status:** needs-decision

- [ ] Product contract states whether Start export is enabled with dirty editor changes.
- [ ] If dirty export is supported, saving completes before a fresh preflight and export submission; cancellation and stale-context guards remain intact.
- [ ] If dirty export is not supported, browser tests explicitly save before export and retain preflight gating.
- [ ] Delayed save, preflight, cancellation, and export polling tests match the chosen contract.
- [ ] `make check` and relevant Playwright tests pass.

## Comments

Opened from ticket 68 triage. Current `client/src/App.tsx` gates Start export on preflight state, while several delayed lifecycle tests expect export to initiate a save. This is an unapproved product-semantics conflict; no speculative behavior change was made.
