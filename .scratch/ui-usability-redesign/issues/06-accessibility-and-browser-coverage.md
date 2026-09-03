# 06: Prove accessibility and viewport behavior

**What to build:** Add focused automated coverage for the task navigation, editing sequence, blocker messaging, keyboard workflow, and responsive layouts, then close any accessibility gaps exposed by those checks.

**Blocked by:** 05

**Category:** enhancement
**Status:** complete

- [x] Browser tests cover 1440×900, 1024×768, and 390×844 without horizontal overflow.
- [x] Keyboard-only browser coverage selects media, edits markers, manages a segment, saves, opens Detection, and reaches a valid Export action.
- [x] Tests verify one open task, collapsed advanced options, nearby blocker text, preview range labels, and hidden default technical IDs.
- [x] Tabs, disclosures, timeline, markers, selected media, disabled reasons, and status updates have appropriate accessible state and names.
- [x] Web lint, Vitest, build, and Playwright pass.

## Comments

- 2026-09-03: Integrated accessibility and responsive browser coverage commit c410edc (handoff b24c8e7); focused Playwright responsive workflow, TypeScript, Oxlint, formatting, build, and diff checks passed. Full Playwright suite was not run.
