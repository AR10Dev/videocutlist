# 01: Compact editor workbench

**What to build:** Global header, independent responsive drawers, preview → unified rail → compact timeline, precise time editing and complete guarded keyboard workflow.
**Blocked by:** None
**Category:** enhancement
**Status:** complete

Implement the matching shell, rail, timeline, keyboard, accessibility and responsive requirements in ../spec.md. Own App.tsx, style.css, app/editor/preview code except CutsView.tsx, and LibraryView.tsx. Preserve existing editing/history/playback seams. Coordinate all shared styling here; ticket 02 uses semantic component classes without editing style.css.

- [ ] Header and state-preserving drawers satisfy desktop/narrow contracts.
- [ ] One rail exposes the specified controls and precise editable timecodes.
- [ ] Timeline range/selection/drag/history behavior remains correct.
- [ ] Keyboard guards, tooltips and accessible names meet the spec.
- [ ] Focused existing unit/browser checks updated and run (leave new comprehensive workspace spec to 03).

## Comments

Spec: `.scratch/editor-workspace-redesign/spec.md`. Starting commit: 33aeb0e965cc08d16ccff30a7bb9bee281f2aebf.

Completed in `9a388886b7a3bd526e097f025c775b416c0b4f31`; merged as `64b1eb2`. Evidence: client format check, lint, Vitest (19 files/94 tests), production build, and `git diff --check` passed.
