# 05: Apply responsive visual hierarchy

**What to build:** Style the redesigned workspace in the existing plain CSS and dark theme so editor controls remain primary, active task actions stay reachable, and all target viewports avoid horizontal overflow.

**Blocked by:** 02, 03, 04

**Category:** enhancement
**Status:** complete

- [x] At 1440×900 the editor receives most width and the active task action is reachable without document-length scrolling.
- [x] At 1024×768 the editor remains primary, task tabs fit without overflow, and no panel creates horizontal scrolling.
- [x] At 390×844 the current-video control precedes editor/timeline controls, task content follows, and controls fit one column.
- [x] Touch targets are at least 44×44 CSS pixels on narrow screens.
- [x] Primary, secondary, selected, marker, and destructive states have distinct visual treatment with visible keyboard focus.

## Comments

- 2026-09-03: Integrated responsive workspace hierarchy commit 266edd0 (handoff d38d1bf); lint, build, Vitest (84 tests), and diff check passed. Playwright segment-selection coverage still uses outdated pre-redesign selectors.
