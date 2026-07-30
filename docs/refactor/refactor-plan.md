# Minimal Transport-Neutral Refactor Plan

Stage 0 is discovery only. The controller freezes each listed contract before
assigning the dependent stage.

1. **Stage 1 — networking configuration.** Add neutral listener address/port,
   public base URL, allowed origins, trusted proxy CIDRs, and read/write/idle
   timeout settings. Default stays `127.0.0.1:8787`; explicit `0.0.0.0` is
   supported without automatic public exposure.
2. **Stage 2 — frontend API boundary.** Route every browser request through a
   normalized base-URL client supporting none, bearer, and cookie auth. Remove
   relative-path bypasses and prove streaming/cancellation across origins.
3. **Stage 3 — CORS and proxy trust.** Add deny-by-default exact-origin CORS
   and generic forwarded metadata only for trusted immediate peers. Test
   preflight and spoofing.
4. **Stage 4 — authentication.** Replace provider-shaped `Identity` with a
   generic principal/authenticator and none, static bearer, and trusted-proxy
   adapters. Provider headers, if retained, are optional boundary adapters.
5. **Stage 5 — protocol regression gate.** Preserve preview streaming,
   cancellation, coalescing, cache safety, opaque media IDs, projects, and
   exports over ordinary HTTP.
6. **Stage 6 — deployment separation.** Make local/LAN/reverse-proxy the main
   deployment flow; relocate Serve material to optional connectivity examples.
7. **Stage 7 — full verification.** Prove binding, separate origins, proxy
   trust, spoofing rejection, auth modes, streaming, cache/concurrency,
   project/export behavior, and operation with no provider executable/env.

## Controller-owned contracts to replace

| Contract | Current provider-specific element | Before |
|---|---|---|
| `docs/contracts/runtime.md` | loopback/Serve-only access, provider login ownership, provider header/capability auth, `tailscale|dev` | Stages 1, 3, 4 |
| `docs/contracts/api.openapi.yaml` | relative server and `tailscaleIdentity` header scheme | Stages 2, 4 |
| `docs/adr/0002-identity-boundary.md` | provider-specific trust boundary | Stage 4 |
| Project ownership contract/types | normalized Tailscale login | Stage 4 |
| Configuration names/types | listener restriction, provider auth mode, implicit timeouts | Stage 1 |

No transport abstraction is needed: HTTP and standard URL handling already
provide the neutral boundary. Connectivity providers are deployment adapters.
