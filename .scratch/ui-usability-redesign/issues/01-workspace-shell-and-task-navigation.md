# 01: Build the focused workspace shell

**What to build:** Restructure the workspace into media explorer, primary editor, and a compact task panel where Project, Export, and Detection are accessible through one semantic single-open tab set. Keep only product, project/save state, and Settings in the header.

**Blocked by:** None

**Category:** enhancement
**Status:** complete

- [x] Exactly one Project, Export, or Detection panel is visible at a time and Project is the default.
- [x] The header shows the current project name or "Unsaved project" plus Saved/Unsaved state.
- [x] Preview, export, detection, and other transient status text is absent from the global header.
- [x] Tab state and relationships are exposed with semantic, keyboard-operable controls.

## Comments

- 2026-09-03: Integrated workspace shell commit; verified focused diff and whitespace checks. Detection tab is disabled until media is selected so one task panel remains visible. Client dependencies are unavailable in this checkout, so web tests/build/lint could not run.
