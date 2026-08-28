# 10: Gate export and interchange actions by lifecycle

**What to build:** Export and interchange actions are available only when their project and job prerequisites are satisfied, and the UI cannot abandon a running server export by starting another one.

**Blocked by:** 09

**Category:** bug
**Status:** completed

- [x] `Start export` is disabled while the current export is queued or running, and its explanation identifies the active job.
- [x] Starting an export never aborts polling for an earlier server job unless that job has first reached a terminal state or been cancelled successfully.
- [x] CSV and chapter export actions remain disabled until the selected video's project has been saved or loaded successfully.
- [x] Disabled interchange actions explain that project persistence is required.
- [x] Export preflight and the primary button never disagree: a blocked preflight cannot display an enabled start action.
- [x] Export completion, failure, and cancellation restore the correct actions without losing the prior job result.
- [x] Playwright coverage attempts repeated export submission, unsaved interchange export, blocked preflight, cancellation, and terminal-state recovery.

**Evidence:** `client/src/App.tsx` gates persisted-project preflight/interchange actions, protects active export polling, and cancels only after server acknowledgement; `client/playwright/interchange.spec.ts` covers unsaved interchange gating. `client` Vitest (63 passed), build, and formatting checks pass. Playwright interchange checks are currently blocked by the existing media fixture not serving the app's media discovery request.

## Comments

The review at `c2dcedf` found that a second export can replace client polling state while the first server job continues, CSV/chapter export controls appear for an unsaved generated project ID, and dirty-project logic can enable `Start export` while the review says preflight is blocked.
