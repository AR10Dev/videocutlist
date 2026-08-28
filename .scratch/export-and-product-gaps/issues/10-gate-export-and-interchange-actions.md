# 10: Gate export and interchange actions by lifecycle

**What to build:** Export and interchange actions are available only when their project and job prerequisites are satisfied, and the UI cannot abandon a running server export by starting another one.

**Blocked by:** 09

**Category:** bug
**Status:** ready-for-agent

- [ ] `Start export` is disabled while the current export is queued or running, and its explanation identifies the active job.
- [ ] Starting an export never aborts polling for an earlier server job unless that job has first reached a terminal state or been cancelled successfully.
- [ ] CSV and chapter export actions remain disabled until the selected video's project has been saved or loaded successfully.
- [ ] Disabled interchange actions explain that project persistence is required.
- [ ] Export preflight and the primary button never disagree: a blocked preflight cannot display an enabled start action.
- [ ] Export completion, failure, and cancellation restore the correct actions without losing the prior job result.
- [ ] Playwright coverage attempts repeated export submission, unsaved interchange export, blocked preflight, cancellation, and terminal-state recovery.

## Comments

The review at `c2dcedf` found that a second export can replace client polling state while the first server job continues, CSV/chapter export controls appear for an unsaved generated project ID, and dirty-project logic can enable `Start export` while the review says preflight is blocked.
