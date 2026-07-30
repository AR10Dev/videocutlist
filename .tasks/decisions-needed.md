# Decisions Needed

None.

## Controller exception — Stage 0 test stabilization

After the Stage 0 re-verifier passed Playwright 2/2, the controller reproduced
the previously observed save-flow failure. A new remediation agent may edit
only `web/playwright/segment-selection.spec.ts` and the Stage 0 baseline report
to remove the status-race flake. No application behavior or public contract may
change.
