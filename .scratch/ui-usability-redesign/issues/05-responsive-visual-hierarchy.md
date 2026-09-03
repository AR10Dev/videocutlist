# 05: Apply responsive visual hierarchy

**What to build:** Style the redesigned workspace in the existing plain CSS and dark theme so editor controls remain primary, active task actions stay reachable, and all target viewports avoid horizontal overflow.

**Blocked by:** 02, 03, 04

**Category:** enhancement
**Status:** ready

- [ ] At 1440×900 the editor receives most width and the active task action is reachable without document-length scrolling.
- [ ] At 1024×768 the editor remains primary, task tabs fit without overflow, and no panel creates horizontal scrolling.
- [ ] At 390×844 the current-video control precedes editor/timeline controls, task content follows, and controls fit one column.
- [ ] Touch targets are at least 44×44 CSS pixels on narrow screens.
- [ ] Primary, secondary, selected, marker, and destructive states have distinct visual treatment with visible keyboard focus.
