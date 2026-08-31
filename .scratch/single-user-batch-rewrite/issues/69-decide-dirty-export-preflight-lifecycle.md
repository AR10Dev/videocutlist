# 69: Decide dirty export and preflight lifecycle

**What to build:** Define and implement the intended export action semantics when the editor has unsaved changes: either require an explicit save before export or save first and then run a fresh preflight before submission.

**Blocked by:** 68

**Category:** enhancement
**Status:** ready-for-agent

- [ ] Start export is enabled with dirty editor changes.
- [ ] Export saves the current edit, then runs fresh preflight and submits from that saved revision; cancellation and stale-context guards remain intact.
- [ ] Delayed save, preflight, cancellation, and export polling tests match the chosen contract.
- [ ] `make check` and relevant Playwright tests pass.

## Comments

Opened from ticket 68 triage. **Decision:** Start export saves the current edit, runs fresh preflight, then submits export from the saved revision. This parallels LosslessCut's separation of persisted edit state from output export: https://github.com/mifi/lossless-cut/blob/master/docs/index.md
