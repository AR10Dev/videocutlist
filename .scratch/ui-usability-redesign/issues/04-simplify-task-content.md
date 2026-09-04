# 04: Simplify Project, Export, and Detection tasks

**What to build:** Reduce each task panel to its primary workflow, move technical/advanced controls into collapsed disclosures, place actionable status beside its action, and use readable media labels.

**Blocked by:** 01

**Category:** enhancement
**Status:** complete

- [x] Project defaults to name/save/new/load/ordered items; ID and revision are collapsed under project details.
- [x] Interchange actions share one subsection and repeated save warnings become one direct save prompt.
- [x] Removing an edited media item is destructive and requires confirmation.
- [x] Export has one primary action, starts with advanced options collapsed, and visibly names every current blocker.
- [x] Detection methods have short descriptions and keep progress, errors, and reviewable results inside Detection.
- [x] Default task content does not expose raw stream language, disposition, indexes, or internal IDs.

## Comments

- 2026-09-03: Integrated project/export/detection simplification commit 6b3dc46 (handoff 42083ae); focused TypeScript, lint, formatting, build, and Vitest (84 tests) passed; full format check reports a pre-existing EditorView.tsx issue; Playwright was not run.
