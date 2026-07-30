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

## Controller exception — Stage 4 bearer-token remediation

The assembled candidate proved that auth configuration accepts an internal
space in a non-empty control-free token while request parsing rejects the same
token. Logical remediation agent `terra-stage-4-fix-1` may edit only
`internal/auth/auth.go` on a new branch to remove the contradictory suffix
whitespace rejection. Exact one-header parsing, the `Bearer ` separator,
constant-time comparison, tests, and every other behavior remain frozen.

## Controller exception — Stage 4 runtime wording remediation

The Stage 4 verifier found one stale controller-owned runtime sentence that
still assigns project ownership to a normalized Tailscale login. Logical
remediation agent `terra-stage-4-fix-2` may edit only that sentence in
`docs/contracts/runtime.md` to use opaque `Principal.Subject` ownership while
preserving cross-owner 404 behavior. No other contract or code change is
authorized.
