# 07: Separate media acquisition from cut-list imports

**What to build:** The UI clearly distinguishes server-indexed video media from cut-list JSON, CSV, and chapter interchange files.

**Blocked by:** 03

**Category:** enhancement
**Status:** complete

- [x] Labels and help text state that interchange files do not upload or add a video.
- [x] Import controls appear only when their media/project prerequisites are met.
- [x] The user can find media setup without mistaking an interchange file chooser for it.

## Comments

The two existing file inputs are easy to mistake for video import.

Completed: the media explorer now explains server-indexed media roots and refresh; the project panel identifies JSON, CSV, and chapter files as cut-list-only interchange. JSON import requires selected media, while CSV/chapter import additionally requires a saved project. Covered by `client/playwright/interchange.spec.ts`.

Validation: `pnpm --dir client exec playwright test playwright/interchange.spec.ts` (2 passed); client format, lint, unit tests (61 passed), and build passed.
