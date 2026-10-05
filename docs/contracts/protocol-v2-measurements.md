# Protocol v2 comparison

Baseline: `14a94962947241b5440ebd6865d39e50059ea009` (preserved user checkpoint).
Candidate: `3f8296d5ad8485b8756a556f2ec059de019b8aa2` plus the final validation/docs
working-tree changes on `integration/protocol-v2`. These measurements describe the
implementation candidate, not publication to main.

| Measurement | Baseline | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Handwritten client TypeScript lines | 11,887 | 13,640 | +1,753 |
| Selected transport/resource/stream infrastructure lines | 199 | 888 | +689 |
| Production JavaScript bytes | 389,715 | 626,075 | +236,360 |
| Production JavaScript gzip bytes | 120,528 | 187,711 | +67,183 |

Counts include blank/comment lines in tracked `client/src/**/*.ts(x)` and exclude
`client/src/generated/` plus colocated `*.test.ts(x)` and `*.spec.ts(x)`. They are
not executable statements or a complexity score.
The explicitly selected infrastructure scope is `api.ts`, `features/app/server.ts`
and `features/queue/jobStream.ts`; only `api.ts` exists at baseline. This is not a
claim that all other feature controllers are free of infrastructure. Generated
contract code is excluded from handwritten counts but included in the bundle when
used. Tests, documentation, dependencies and build output are excluded from source
counts. Gzip uses Node's default `gzipSync` for each emitted JS asset and sums sizes;
it is not Vite's displayed gzip estimate or the size of a single concatenated file.

Both versions used their own frozen pnpm lockfile and repository-pinned devenv
runtime, `pnpm --dir client run build`, with default production Vite settings and
no feature flags. The larger bundle and source totals are reported without a
performance/correctness improvement claim; durable command/SSE/resource behavior
was also added, so this is not a same-functionality optimization benchmark.

## Reproduce

```sh
git worktree add --detach /tmp/videocutlist-v2-baseline-measure 14a94962947241b5440ebd6865d39e50059ea009
(cd /tmp/videocutlist-v2-baseline-measure && devenv shell -- pnpm --dir client install --frozen-lockfile && devenv shell -- pnpm --dir client run build)
devenv shell -- pnpm --dir client install --frozen-lockfile
devenv shell -- pnpm --dir client run build
devenv shell -- node client/scripts/measure-protocol.mjs /tmp/videocutlist-v2-baseline-measure .
```

Run against the exact candidate tree before publishing its measurements. Baseline
build output and dependencies are disposable and are not committed. Timing,
heap/network behavior, Go binary size and broad backend infrastructure size are
not measured by this comparison.
