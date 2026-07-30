# Repository Instructions

Read `deep-research-report.md`, `CODEX_MULTI_AGENT_IMPLEMENTATION_PROMPT.md`,
and `docs/contracts/runtime.md` before changing behavior.

## Commands

- Prefix shell commands with `rtk`.
- The integration commands are `make check`, `make test`, and `make smoke`.
- Go must pass `gofmt`, `go vet`, and `go test -race ./...`.
- Web code must pass lint, Vitest, build, and Playwright.

## Architecture and security

- The Go service binds to `127.0.0.1` by default and is exposed only through
  Tailscale Serve. Never enable Funnel.
- Never accept or return an original-media filesystem path.
- Resolve opaque media IDs beneath configured roots after symlink resolution.
- Invoke FFmpeg/FFprobe with argument arrays, cancellable contexts, and bounded
  stderr. Never interpolate a shell command.
- Write incomplete cache/export data to temporary files and publish it only by
  atomic rename after successful validation.
- Do not describe non-keyframe stream-copy cuts as frame-exact.
- Do not enable a hardware encoder until a real probe transcode succeeds.

## Ownership and contracts

- The controller owns `AGENTS.md`, `docs/contracts/`, shared contract types,
  migration numbering, `.tasks/`, integration decisions, and security gates.
- Agent path ownership is recorded in `.tasks/active.md`.
- Do not edit another agent's paths or public interfaces without a controller
  exception recorded in `.tasks/decisions-needed.md`.
- Generated files must identify their generator and be reproducible.

## Commits and handoff

- Keep commits reviewable and scoped to one task.
- Every handoff includes summary, changed files, tests with results, risks,
  contract changes, and commit hash.
- Never commit secrets, media originals, generated previews, exports, caches,
  database files, or worktrees.

