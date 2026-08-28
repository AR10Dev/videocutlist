# Single-user batch rewrite

**Status:** ready-for-agent

## Problem

VideoCutlist is permanently a self-hosted, single-user application, but its backend carries multi-user ownership and authorization machinery. Projects currently edit one media file, asynchronous work uses several incompatible job implementations, busy workers reject new work instead of queuing it, and the browser concentrates most workflows in one application function.

## Outcome

One self-hosted Go process manages ordered projects containing multiple independent media edits. Export, detection, and library scans use a bounded durable SQLite queue. The user can continue editing while jobs run, and queued work survives a restart. Original-media paths remain server-only.

## Product decisions

- A project contains ordered independent media items. Each item has its own segments and export options.
- A batch may export selected project items, producing independent outputs. A continuous timeline spanning source files is out of scope.
- There is one user. Projects, jobs, and settings have no owner, role, or capability fields.
- Loopback access may run without authentication. Remote access uses one application token or an authenticating reverse proxy.
- Projects and media records are preserved by the breaking schema migration.
- Queued jobs survive restart. Running jobs interrupted by restart fail explicitly until artifact reconciliation proves success.
- Interactive previews do not enter the durable background queue.

## Architecture

```text
cmd/videocutlist
internal/db
internal/library
internal/projects
internal/jobs
internal/preview
internal/export
internal/detection
internal/settings
internal/httpapi
internal/web
```

Feature modules own their behavior and SQL. HTTP handlers translate requests and responses. Interfaces exist only at real seams with more than one adapter.

## Technology stack

### Runtime

- Go standard library
- `modernc.org/sqlite`
- SQLite in WAL mode
- FFmpeg and FFprobe child processes
- SolidJS stable release
- `@tanstack/solid-query`
- Plain CSS

### Build and validation

- TypeScript and Vite
- OpenAPI with `openapi-typescript` generated browser types
- Oxlint and Oxfmt
- Vitest and Playwright
- Go tests, race detector, vet, and gofmt

No ORM, external queue, Redis, PostgreSQL, GraphQL, WebSockets, Tailwind, UI framework, or Go FFmpeg binding is introduced.

## Durable contracts

- Media access resolves opaque IDs below configured roots through open descriptors.
- A project save validates every item against current media metadata and uses optimistic revision checks.
- A queued job stores an immutable project-item, source-fingerprint, export-option, and runtime-setting snapshot.
- Queue admission and insertion are one SQLite transaction. Queue capacity and worker concurrency are separate limits.
- State transitions are conditional and terminal states never transition.
- Incomplete cache and export artifacts remain temporary until validation and atomic publication succeed.
- Batch state is derived from child jobs.
- Unsafe same-origin browser mutations reject foreign origins when proxy cookies can authenticate requests.

## Delivery order

Implement tickets in dependency order. New behavior should land in the target feature modules. Remove the old horizontal packages only after all callers have moved.

## Superseded work

This rewrite supersedes the proposed `.scratch/settings-management/` plan. Deployment paths become deployment-only; the browser receives aliases and safe availability diagnostics rather than original-media or destination paths.

## Out of scope

- Multiple users, tenants, roles, or per-user quotas
- Distributed workers or multiple server instances
- Continuous timelines joining several source files
- Transitions, compositing, or audio mixing between files
- Automatic retries after interrupted exports
- Manual queue reordering
