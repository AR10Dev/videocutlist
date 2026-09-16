# Engineering rules

## Workflow and scope

- Read the affected code and its callers before editing. Reuse existing patterns;
  make the smallest complete change and remove superseded code.
- Keep each change focused. Separate dependency upgrades, unrelated refactors,
  and redesigns unless they are inseparable from the task.
- Follow the existing layout; do not scaffold layers or rename directories just
  to match a template. Add abstractions only for a demonstrated boundary or need.

## Ownership and repository layout

Go owns business rules, authorization, and data integrity. SolidJS owns client
interaction and reactivity. Tailwind CSS and daisyUI own presentation.

- Keep one Go module. Application code belongs in `internal/`; expose a public
  package only when another module actually needs it.
- `cmd/videocutlist/` wires configuration, dependencies, routes, server startup,
  and graceful shutdown; keep application logic out of the entry point.
- `internal/httpapi/` handles HTTP parsing and responses. Domain packages implement
  application rules; `internal/db/` owns database operations, with checked-in
  schema changes under `internal/db/migrations/`.
- Backend dependencies flow from HTTP handlers to domain services to storage or
  external services. Keep SQL out of handlers and HTTP concerns out of storage.
  These are responsibility boundaries, not a requirement for wrapper packages.
- The frontend lives in `client/`, not `web/`. Keep feature-specific UI and logic
  together under `client/src/features/`; extract shared components by
  responsibility or reuse, not line count. Give helpers domain-specific names.
- Centralize HTTP access in `client/src/api.ts`. Pages/features compose UI and
  domain state; reusable presentation components should not own networking,
  authorization, or business rules.

## Go and API contracts

- Pass dependencies explicitly through constructors; avoid mutable global state.
  Introduce small, consumer-owned interfaces for real behavioral boundaries,
  alternative implementations, or focused testing needs.
- Pass `context.Context` through request-bound database queries, external calls,
  and long-running work; honor cancellation and deadlines.
- Handle meaningful errors. Wrap causes with useful context and `%w`; return
  safe public errors rather than database details or internal implementation data.
- Validate input and enforce authorization in Go at every relevant boundary.
  Frontend validation and hidden controls are UX, not security controls.
- Preserve the API error envelope: `error.code`, `error.message`, and
  `error.requestId`. Clients branch on stable codes, not message text.
- Follow documented endpoint status conventions. For new endpoints use 400 for
  invalid input, 401 for missing/invalid authentication, 403 for denied access,
  404 for missing resources, 409 for conflicts, 429 for rate limits, and 500 for
  unexpected failures. Document deliberate exceptions in the API contract.
- Keep request/response types independent of database models where needed to
  prevent schema changes from accidentally changing JSON responses.
- Update `docs/contracts/api.openapi.yaml` with API changes, regenerate TypeScript
  via `pnpm --dir client run api:generate`, and commit the generated result in
  `client/src/generated/api.ts`. Do not hand-edit generated types.
- Use reviewed, checked-in migrations for every database schema change; include
  relevant migration checks and avoid undocumented manual schema changes.
- Load backend configuration from the environment and validate it at startup.
  Shut down gracefully on termination, draining requests and closing resources.
- Use structured logs with request ID, method, route, duration, and error category
  where applicable. Propagate/return correlation IDs without logging secrets,
  tokens, session IDs, or sensitive request bodies.

## SolidJS and presentation

- Use TypeScript. Prefer `unknown` plus validation/narrowing at untyped boundaries;
  avoid `any` in application code.
- Follow Solid's reactive semantics, not React rerender patterns. Derive values
  directly or with memos; reserve effects for side effects rather than keeping
  duplicate state synchronized. Preserve reactivity when reading props/state.
- Keep state local; use shared stores/context only for genuinely shared state.
- Account for applicable loading, empty, error, and success states in async UI.
- Prefer daisyUI component classes and semantic modifiers, then Tailwind utilities
  for layout/spacing and intentional overrides. Use custom CSS only when those
  cannot express the requirement cleanly, not to alias a few utilities.
- Use semantic theme tokens such as `bg-base-100`, `text-base-content`, and
  `btn-primary`; centralize theme configuration rather than inventing page colors.
- Select complete Tailwind class strings conditionally; avoid constructing partial
  class names that the build cannot detect.
- Use semantic HTML, labeled inputs, accessible names for icon-only controls, and
  keyboard-operable dialogs/menus. Styling does not supply interactive behavior.
- Treat everything bundled by Vite as public. Keep secrets on the Go server.

## Media security and correctness

- Bind the Go service to `127.0.0.1` by default.
- Never accept or return an original-media filesystem path. Resolve opaque media
  IDs beneath configured roots after symlink resolution.
- Invoke FFmpeg/FFprobe with argument arrays, cancellable contexts, and bounded
  stderr. Never interpolate a shell command.
- Write incomplete cache/export data to temporary files; publish only by atomic
  rename after successful validation.
- Do not describe non-keyframe stream-copy cuts as frame-exact.
- Enable a hardware encoder only after a real probe transcode succeeds.
- Never commit secrets, media originals, generated previews, exports, caches,
  database files, or worktrees.

## Dependencies and validation

- Enter `devenv shell` for project-local tooling. Honor repository-pinned runtimes;
  prefer current Node LTS only when no repository pin exists.
- Use pnpm exclusively for JavaScript dependencies. Commit the relevant pnpm
  lockfiles and Go's `go.mod`/`go.sum`; avoid unnecessary committed `replace`
  directives. Keep Tailwind/daisyUI major upgrades compatible and separately scoped.
- Use the configured formatters/linters: `gofmt` for Go and the scripts in
  `client/package.json` for frontend code; do not introduce competing tools.
- Test behavior at its natural boundary: domain rules, database integration,
  HTTP handlers, Solid state/utilities, and critical end-to-end journeys. Bug
  fixes normally include a regression test. Prefer inexpensive real dependencies
  and use fakes/mocks at meaningful external boundaries.
- Run targeted checks while iterating. Before handoff, run `make smoke` once:
  it includes `make check` (lint, vet, race tests, Vitest, production builds,
  embedded-frontend checks) and Playwright. Also run
  `pnpm --dir client run format:check` and `go test -race ./...`.
- Run `make test-real-media` when changing production media workflows; its first
  run downloads the verified Sintel fixture. CI is the merge gate, not a substitute
  for reporting local validation accurately.
- Done means formatted, type-safe, appropriately tested, production-buildable,
  with applicable UI states, authorization, migrations, and API contracts covered.
  Report any failed or unrun checks instead of claiming completion.
- Handoffs include summary, changed files, test results, risks, contract changes,
  and commit hash (or explicitly state that no commit was created).

## Agent skills

### Issue tracker

Issues are local Markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the five canonical label strings. See `docs/agents/triage-labels.md`.

### Domain docs

Domain documentation uses a single-context layout. See `docs/agents/domain.md`.
