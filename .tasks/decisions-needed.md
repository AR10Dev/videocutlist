# Decisions Needed

None.

## Controller exception — Stage 0 test stabilization

After the Stage 0 re-verifier passed Playwright 2/2, the controller reproduced
the previously observed save-flow failure. A new remediation agent may edit
only `web/playwright/segment-selection.spec.ts` and the Stage 0 baseline report
to remove the status-race flake. No application behavior or public contract may
change.

## Controller exception — Stage 3 preflight remediation

The assembled candidate's frozen CORS test proved that the CORS implementer
omitted two required preflight `Vary` values. The separately assigned logical
remediation agent `terra-stage-3-fix-1` may edit only
`internal/httpx/cors.go` on a new branch to add
`Access-Control-Request-Method` and `Access-Control-Request-Headers`. It may
not change any other CORS behavior, test, contract, or public interface.
