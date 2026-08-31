# 11: Update the frontend stack and generated API contract

**What to build:** A stable SolidJS client foundation with generated OpenAPI types and TanStack Solid Query owning server-state lifecycles.

**Blocked by:** 02, 03, 05, 08, 09, 10

**Category:** enhancement
**Status:** completed

- [x] The client uses a stable SolidJS release compatible with the selected Vite and TypeScript versions.
- [x] `openapi-typescript` generates request and response types from the checked-in OpenAPI contract during a reproducible script.
- [x] Handwritten duplicates of server media, project, batch, job, settings, and error types are removed.
- [x] TanStack Solid Query owns media loading, project loading and saving, job polling, cancellation, invalidation, and stale-response protection.
- [x] The API client retains same-origin URL confinement and configured token or proxy-cookie behavior.
- [x] Plain CSS remains the styling system; no Tailwind or component framework is added.
- [x] Vite build, TypeScript checking, Oxlint, Oxfmt, and Vitest pass through the existing Make targets.
- [x] Tests cover generated-contract drift and query cancellation behavior.

## Comments

- Completed through tickets 49–74.
- Validation: `make check` passes; full Playwright passes (43 tests).
