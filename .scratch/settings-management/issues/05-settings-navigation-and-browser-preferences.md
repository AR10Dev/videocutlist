# 05: Add Settings to the navbar and retain browser preferences

**What to build:** Replace the inline bottom Settings panel with an accessible navbar Settings icon that opens a focused Settings view. Keep per-browser editor preferences local.

**Blocked by:** 04

**Category:** enhancement
**Status:** wontfix

- [ ] The application header includes a recognizable gear icon button with visible tooltip/text alternative, `aria-label="Settings"`, keyboard access, and selected-state semantics.
- [ ] Opening Settings does not discard unsaved project edits; returning restores the editing context.
- [ ] The page has distinct sections for Library, Exports, Performance, Editor, and About/Diagnostics; unavailable administrator controls explain why rather than appearing editable.
- [ ] Existing local preferences (mute default, cut strategy, filename template) remain browser-local and are clearly labelled as such.
- [ ] Reset affects browser-local preferences only and never resets server configuration.
- [ ] Unit and Playwright coverage verify navbar access, keyboard/accessibility behavior, unsaved-work preservation, local preference persistence, and unavailable/forbidden server settings state.

## Comments

Superseded by `.scratch/single-user-batch-rewrite/`. Browser preferences remain local, while the replacement UI work is tracked in issues 11 and 12.

Use an inline SVG icon or existing project assets; do not add an icon package for one navbar button.
