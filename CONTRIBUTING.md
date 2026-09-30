# Contributing

Thanks for helping improve VideoCutlist.

## First time in the codebase

From the repository root, enter the pinned development environment:

```bash
devenv shell
make client-install
make build
make run
```

Open <http://127.0.0.1:8787>. An unconfigured media library is expected until
you supply media roots; follow [Run locally](README.md#run-locally) for a
media-backed session with a separate data directory. Default `make run` state
lives under `.cache/videocutlist/`.

Use this contributor guide for development workflows and the
[user documentation](docs/README.md) for expected behavior.
Detailed repository and automation constraints live in [AGENTS.md](AGENTS.md);
consult the relevant rules before changing ownership, contracts, or security.

## Where to verify a change

- Go package tests live beside their implementation. Cross-module scenarios
  live under [`test/integration/`](test/integration/).
- Frontend state and utility tests live in [`client/tests/`](client/tests/).
  Browser journeys live in [`client/playwright/`](client/playwright/).
- Real-process media workflows live in [`test/realmedia/`](test/realmedia/) and
  [`client/playwright-real/`](client/playwright-real/).
- Performance measurements live under [`test/performance/`](test/performance/).
  Shared fixture tooling lives under [`test/harness/`](test/harness/).

Local browser checks use Playwright-managed Chromium. Install it once before
running `make e2e` or `make smoke`:

```bash
pnpm --dir client exec playwright install chromium
```

CI mode selects system Chrome instead. If your local shell exports `CI`, use
`env -u CI make smoke` to select the local browser while still running `make check`.

Use the focused package or feature checks while iterating. For an HTTP contract
change, edit `docs/contracts/api.openapi.yaml`, regenerate with
`pnpm --dir client run api:generate`, and include the resulting
`client/src/generated/api.ts`; that file is generated but checked in.

## Build output and local state

The frontend build produces `client/dist/`. `make build` copies it into
`internal/web/webassets/dist/` for Go's embedded-frontend build; both directories
are disposable and ignored. Keep this build handoff separate from media assets,
which are generated at runtime.

Run `make clean` to remove build output, test results/reports, coverage output,
Vite/Vitest caches, the default Go executable, root-level Go test binaries, and
root/client TypeScript build metadata. It preserves installed dependencies,
devenv state, `.scratch/`, media fixtures, application data, and container-mounted
state. Rebuild before serving
the frontend or compiling with `-tags embed_frontend`.

Runtime `.cache/` contents may include databases, test media copies, previews,
and exports, so they are deliberately outside `make clean`. Custom output
locations are also outside its scope; inspect them before removing anything.

## Before opening a pull request

1. Keep changes focused and explain the user-visible result.
2. Add or update tests for non-trivial behavior.
3. Run the checks locally:

   ```bash
   make smoke
   pnpm --dir client run format:check
   go test -race ./...
   ```

4. Do not commit media originals, previews, exports, caches, databases, secrets,
   or worktrees.
5. Use pnpm and keep `client/pnpm-lock.yaml` synchronized with `client/package.json`.

## Project boundaries

- The service binds to `127.0.0.1` by default.
- Original-media paths must not be accepted from or returned to browsers.
- FFmpeg and FFprobe must be invoked with argument arrays and cancellable
  contexts.
- Publish incomplete cache and export files only through atomic rename.

When removing duplication, keep shared behavior in its owning module and update
all callers together. Verify behavior at that module's boundary and exercise
the affected workflows; preserve authorization, validation, cancellation, and
public API contracts.

Please use a clear commit or pull-request title and include relevant test
results. GitHub Actions runs the same checks for pull requests. Run `make test-real-media`
when changing production media workflows; its first run downloads the verified
Sintel fixture.
