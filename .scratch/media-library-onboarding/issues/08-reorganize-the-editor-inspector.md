# 08: Make the inspector contextual

**What to build:** The right inspector presents project, export, detection, and settings only when each section is useful for the selected video and current task.

**Blocked by:** 06

**Category:** enhancement
**Status:** complete

- [x] Project identifiers do not dominate first-run UI.
- [x] Export options show source-dependent data only after media selection.
- [x] App settings remain available without duplicating active-export controls.

## Comments

This ticket changes task flow, not visual decoration.

- Project, export, and auto-detection inspector sections render only after media selection; settings remain available on first run.
- Export cut strategy and filename controls are contextual; settings only expose browser defaults and reset.
- Validation: `pnpm --dir client test`, `pnpm --dir client run test:e2e`, `pnpm --dir client run build`, `pnpm --dir client run lint`, `pnpm --dir client run format:check`.
