# Protocol v2 and test-retention completion

Both implementation efforts are accepted for retirement from `.scratch/` and
local commit on `integration/protocol-v2`. Main publication and remote push are
not part of this closure. Existing implementer worktrees are left untouched.
The reviewed tree was `3f8296d` plus the final working-tree changes; this document
is committed with those changes.

## Protocol v2

Implemented JSON control routes under `/api/v2/`, native media/file routes under
`/media/v2/`, transactional durable command idempotency, persisted job revisions,
authenticated bounded SSE observation, generated Effect 4.0.0 JSON clients and
workspace-owned resource state. Legacy editing, save/recovery, settings and media
behavior remains covered. Superseded v1 application callers and old frontend
validation/polling infrastructure have been removed.

The permanent references are the [OpenAPI contract](../contracts/api.openapi.yaml),
[upgrade guide](../contracts/api-v2-migration.md),
[boundary decision](../adr/0001-json-control-native-media.md), and
[source/bundle comparison](../contracts/protocol-v2-measurements.md).
This closure introduces no additional API schema or database migration.

## Test-retention audit

The initial audit mapped 125 files and 804 candidate-registration lines across
nine lanes; candidate lines are not a runtime test count. All 109 implementation
dispositions were independently compared with current test bodies and retained
witnesses:

| Disposition | Count |
| --- | ---: |
| Repaired | 90 |
| Merged after assertion transfer | 10 |
| Removed as redundant or tautological | 5 |
| Narrowed to the behavior actually proved | 4 |

Repairs cover causal callbacks, persisted mutations, durable cancellation,
late-response ownership, cancellation/publication barriers, reader cleanup,
fixture correctness and browser accessibility. Removed stream-index helper tests
retain live validation coverage in `internal/export/preflight_test.go`.
No blanket test-removal or Windows-portability claim is made.

## Fresh validation and review

All checks ran in the repository-pinned `devenv shell`:

- `make smoke`: final PASS, 30 Vitest files / 253 tests and 138 Chromium tests,
  plus lint, vet, Go race, production build and embedded-frontend checks.
- `pnpm --dir client run format:check`: PASS.
- `go test -race ./...`: PASS.
- `make test-real-media`: PASS, 45-route inventory, real-process workflows and
  one real-browser export/download/probe journey.
- `pnpm --dir client run api:generate`: PASS, no generated-file difference.
- `git diff --check`: PASS.

The first smoke run had one 30-second timeout during the panel-persistence test's
page reload (137 browser tests passed). Its isolated unchanged rerun passed,
then the complete unchanged default smoke rerun passed. An intervening `CI=1`
run failed to launch browsers because `/opt/google/chrome/chrome` was absent;
it is not passing evidence. No test was removed or assertion weakened to pass.
Logs are local under `/tmp/vcl-close-audits/`, not committed build artifacts.

Fresh independent Spec and Standards reviews returned no implementation blockers.
Spec review checked all 109 dispositions and the protocol's production seams;
Standards review prioritized dirty production changes and test correctness rather
than claiming exhaustive review of all historical commits. LSP reported no active
errors in eight probed production files, but six clean checks were unconfirmed;
the successful TypeScript build and Go checks supply the compiler evidence.

Remaining risks: browser reload timing can be flaky under load, media tests retain
Unix/Linux-specific assumptions, and the production bundle is larger (gzip
+67,183 bytes in the documented comparison). Runtime performance is unmeasured.
