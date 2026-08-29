# 11: Update the frontend stack and generated API contract

**What to build:** A stable SolidJS client foundation with generated OpenAPI types and TanStack Solid Query owning server-state lifecycles.

**Blocked by:** 02, 03, 05, 08, 09, 10

**Category:** enhancement
**Status:** ready-for-agent

- [ ] The client uses a stable SolidJS release compatible with the selected Vite and TypeScript versions.
- [ ] `openapi-typescript` generates request and response types from the checked-in OpenAPI contract during a reproducible script.
- [ ] Handwritten duplicates of server media, project, batch, job, settings, and error types are removed.
- [ ] TanStack Solid Query owns media loading, project loading and saving, job polling, cancellation, invalidation, and stale-response protection.
- [ ] The API client retains same-origin URL confinement and configured token or proxy-cookie behavior.
- [ ] Plain CSS remains the styling system; no Tailwind or component framework is added.
- [ ] Vite build, TypeScript checking, Oxlint, Oxfmt, and Vitest pass through the existing Make targets.
- [ ] Tests cover generated-contract drift and query cancellation behavior.

## Comments
