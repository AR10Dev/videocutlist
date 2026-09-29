# Backend benchmarks

Run from `devenv shell` on an otherwise idle machine:

```sh
make benchmark-backend
# Fast end-to-end smoke (same scenarios, fewer samples):
BENCH_API_SCALES='100' BENCH_API_SAMPLES=2 BENCH_MEDIA_REPEATS=1 make benchmark-backend
# Run either family separately:
./test/performance/run-backend.sh api
./test/performance/run-backend.sh media
```

The runner builds a production Go server on a random loopback port with a disposable SQLite database, cache and export directory under `mktemp`; each workspace is removed on exit. **Do not point a benchmark at production data.** `api` mode has an empty configured media root and loopback-only unauthenticated access: no media fixture, FFmpeg/FFprobe or OpenSSL is needed. `media` mode checks/downloads the verified Sintel trailer and starts with bearer authentication; the disposable token is passed to benchmark commands through `VIDEOCUTLIST_BENCH_TOKEN` rather than a process argument. `all` runs API first and media second in **separate disposable servers/databases**, keeping the API catalog pages free of fixture records. Redirect CSV stdout to a file outside the repository if you want to keep results. Diagnostics and fixture acquisition use stderr. The API catalog seed is metadata-only; it is inserted *after* initial scanning and must not be followed by a refresh/restart before the corresponding measurements.

## Coverage and interpretation

| Family | Scenarios | Default scale |
| --- | --- | --- |
| API/SQLite | First/late pages of `/media` and root/deep `/media/tree`; serial and concurrent HTTP requests | 100, 1,000, 5,000 indexed records; 100 completed requests per scenario |
| Media scanning | New fixture copied into the media root, then unchanged rescan; optional linked-file scaling, request admission and job completion | Verified 52-second Sintel trailer; one first import and one rescan per invocation |
| Previews | Distinct 2-second windows: cache miss, validated GET hit and validated HEAD hit; response headers/body timings; cold parallel requests | 2 parallel requests |
| Assets | Thumbnail PNG and waveform JSON for a new spec, repeat and 304 conditional revalidation; optional waveform spec cardinality | 1-second windows |
| Export | Two segments, MKV stream-copy-preferred and precise re-encode; admission, end-to-end, queue wait/processing when job transitions observed; output download checked with FFprobe | 8 seconds per segment |
| Mixed | Catalog browse and warm preview while re-encode is running | 1 export at a time |

`BENCH_API_SCALES` (space-separated integers, 100–10000), `BENCH_API_SAMPLES`, `BENCH_MEDIA_REPEATS`, and `BENCH_CONCURRENCY` tune the runner. Keep `BENCH_CONCURRENCY` within the server's default preview process limit (2) for the media suite; more concurrent cold misses can legitimately return 429. `BENCH_SCAN_FILES` (1–9000) stages one copied fixture plus hardlinks of that same file for an import/rescan workload, alongside the original fixture already indexed; it **does not** model heterogeneous codecs, physical disk reads or source identity diversity. `BENCH_ASSET_CARDINALITY` (default 0) primes that many distinct one-second waveform specs and times repeats of the last spec. `BENCH_EXPORT_SEGMENT_MS` changes the duration of *each* of two exported segments (default 8000). For direct invocation, `go run ./test/performance/api -help`, `go run ./test/performance/media -help`, and the runner source show flags. Use representative *additional* codecs/resolutions and storage devices by running the media command against a disposable configured server/root; Sintel alone does not represent all production media. Hybrid smart cut is not benchmarked with Sintel because that fixture is incompatible.

CSV columns: `scenario,scale,cache,concurrency,samples,p50_ms,p95_ms,p99_ms,throughput_per_s,bytes_per_s,errors`. API throughput uses total wall time across requests, while media rows measure distinct workflow phases; compare like-named rows only. A `warm` API label means after a warm-up request, not a cache hit. A `new_spec_unverified` asset label is deliberately *not* proof of a cold filesystem cache; `repeat_same_spec` checks identical bytes but does not expose an internal cache-hit signal. Likewise `repeat_same_spec_unverified` at larger cardinalities may be regeneration under cache pressure. A 304 measures conditional validation rather than cached generation. Preview hit/miss labels are checked against `X-Preview-Cache`; `preview.head.complete` is a zero-body HEAD after a proven warm GET, with matching preview metadata headers, whereas `preview.complete` includes the GET body. Export job phase times come from durable job timestamps when the running transition was observed; a fast job can yield only end-to-end measurements. The program fails on unexpected HTTP responses, malformed results or invalid export output instead of treating failures as fast samples.

The HTTP workload suite and the deterministic `go test ./internal/db -run '^$' -bench '^BenchmarkMedia(Browse|SyncUnchanged)' -benchmem` complement each other. Database benchmark setup is outside the timed loop; `Browse` reports `ns/op` and allocations for root/deep pages at 100/1,000/5,000/10,000 rows, and unchanged `Sync` also reports items/s. `BenchmarkMediaBrowseWaitStats` compares one/two simultaneous callers at 5,000 rows and reports `waits/op` and `wait_ns/op` from `sql.DB.Stats()` deltas. Run `go test ./internal/db -run '^TestMediaBrowseUsesParentIndexes$' -v` to inspect the asserted SQLite query plans. HTTP `throughput_per_s` counts requests or completed media operations, not indexed items/s; export `bytes_per_s` uses output bytes, not input-media throughput. Keep FFmpeg and real-media measurements opt-in rather than putting media downloads or timing thresholds in `make smoke`.

Set `BENCH_RESOURCES_FILE=/external/path/resources.csv` for a Linux `/proc` resource sidecar, separate from benchmark CSV stdout. Its header is `phase,scale,process,cpu_seconds,peak_rss_bytes,read_bytes,write_bytes,sampled_processes`; phases are `api_seed`, `api_run` and `media_run`, grouped by server, FFmpeg or FFprobe. The runner builds server and benchmark binaries once before sampling; setup is not included in timed HTTP results or per-phase sidecar. CPU and physical I/O are *observed counter deltas*, not complete process-lifetime totals; peak RSS is the highest sampled simultaneous sum per process class, not `VmHWM`. About 20 ms between samples can miss short FFprobe children: absent counters are blank or rows omitted, **not zero**. On unsupported platforms, requesting the sidecar warns and runs the normal CSV benchmark without a sidecar. For more complete CPU, RSS and I/O, collect process-level telemetry alongside CSV (e.g. `pidstat -urd -p <server-pid> 1`, `pidstat -urd -C ffmpeg 1` and `iostat -xz 1` if available). Record machine model, Go/FFmpeg versions, storage, dataset/codecs, concurrency, OS cache state and run date. Repeat comparable runs and compare p50/p95/p99, throughput, bytes/s and failures. OS page-cache state is not reset by the runner; a fresh API request is not a cold disk read. `/metrics` has cumulative sums/counts and cache hit/miss counters but no latency histogram. Do not use these measurements as a performance gate without a hardware-specific baseline and variance analysis.

## Coverage ledger

The CLI measures **production HTTP plus storage/media paths**, not every backend route. Here, “exercised” means a prerequisite or validation request is made but its latency is not reported separately.

| Backend area | Benchmark status | Still needed for performance decisions |
| --- | --- | --- |
| Media catalog and SQLite browsing | Timed list/tree first and late pages at three sizes, one/two clients; indexed `Browse`/`Sync` package benchmarks, asserted SQLite query plans and one/two-client connection-wait benchmark | Different folder topologies, larger libraries and connection waits under representative mixed workloads |
| Index scan and catalog sync | One staged first import and unchanged rescan, optional 100/1,000 linked entries, timed end to end; SQL sync items/s | Heterogeneous multi-thousand-file catalog on real storage; separate walk, FFprobe and SQL timings |
| Preview cache/FFmpeg and timeline assets | Preview miss, GET/HEAD hit, parallel misses, thumbnail/waveform first/repeat/304, optional waveform spec cardinality | Per-stage validation trace, cache eviction under memory/disk pressure and representative codecs |
| Projects, export policy, scheduler, artifact publication | Project PUT, preflight and polling exercised; stream copy and precise re-encode job phases timed; output downloaded and probed | Project read/write load, many queued jobs, batch download, cancellation/retry, archive destination, compatible hybrid smart cut |
| Detection, interchange, automation, MCP, credentials and runtime settings | Not timed | Representative workloads only if user traffic or profiling identifies a need; keep security/correctness tests independent |
| Auth, HTTP routing and source validation; metrics/health/readiness | First group traversed incidentally; metrics/health/readiness not measured | Separate CPU/latency profiles before changing safety boundaries |

## Recorded local baseline (2026-09-29 UTC)

Working tree at `be7d7ef` with uncommitted changes; Linux x86-64, Intel i7-12700H (20 logical CPUs), Go 1.26.7, FFmpeg n9.0.2. These are **observations on one warm local machine**, not thresholds, version comparisons or expected production latency. API: 100 completed HTTP requests per scenario/concurrency; media: three repetitions of each window/export, but only one first import and one unchanged rescan. Separate disposable servers per command. Startup, fixture staging, catalog seeding, building binaries and export output verification are outside request/job phase timings. Two full media runs and an additional API run at 1,000/5,000 rows reproduced the ranking; only the first successful run is tabulated. The initial media run exposed a reused cold-preview window at repeat count 3; the harness now advances windows per concurrent batch, and both subsequent three-repeat runs completed without errors.

| Scenario | Catalog size / cache state | Clients / samples | p50 ms | p95 ms | p99 ms |
| --- | --- | --- | ---: | ---: | ---: |
| `media_list_first` | 100 / warm | 1 / 100 | 0.500 | 0.838 | 0.990 |
| `media_list_first` | 1,000 / warm | 1 / 100 | 0.488 | 0.765 | 0.788 |
| `media_list_first` | 5,000 / warm | 1 / 100 | 0.467 | 0.734 | 0.979 |
| `media_tree_root_first` | 100 / warm | 1 / 100 | 0.423 | 0.635 | 0.779 |
| `media_tree_root_first` | 1,000 / warm | 1 / 100 | 1.746 | 2.611 | 2.897 |
| `media_tree_root_first` | 5,000 / warm | 1 / 100 | 8.267 | 10.535 | 11.037 |
| `media_tree_deep_first` | 5,000 / warm | 1 / 100 | 10.284 | 12.381 | 14.181 |
| `media_tree_root_first` | 5,000 / warm | 2 / 100 | 15.811 | 18.112 | 19.131 |
| `media_tree_deep_first` | 5,000 / warm | 2 / 100 | 19.618 | 22.856 | 24.372 |
| `scan.import_first.completed` | One staged fixture alongside original | 1 / 1 | 41.859 | — | — |
| `scan.rescan_unchanged.completed` | Two unchanged fixtures | 1 / 1 | 42.232 | — | — |
| `preview.complete` | 2 s / miss | 1 / 3 | 136.145 | 143.239* | — |
| `preview.complete` | 2 s / hit | 1 / 3 | 19.755 | 22.837* | — |
| `thumbnails.complete` | 1 s / new spec, then repeat | 1 / 3 each | 50.075 / 0.730 | — | — |
| `waveform.complete` | 1 s / new spec, then repeat | 1 / 3 each | 21.960 / 0.449 | — | — |
| `preview.concurrent.complete` | 2 s / separate misses | 2 / 3 batches | 170.338 | — | — |
| `export.stream_copy_preferred.end_to_end` | 2 × 8 s segments | 1 / 3 | 167.078 | — | — |
| `export.mixed.precise_reencode.end_to_end` | 2 × 8 s, concurrent browse/preview | 1 / 3 | 1230.124 | — | — |

\* With three media samples, p95 is the observed maximum, **not** a stable tail-latency estimate. One-pass scan numbers likewise cannot establish scan scaling. A sampled `/proc` observer (40 ms interval; not part of the committed runner) saw ~11.3 server CPU-seconds and ~30 MiB sampled peak RSS over an 11.5 s API command; that command's wall time includes setup and catalog seeding, but the server CPU count does **not** include the separate seeder process. For a 6.7 s media command it saw ~0.22 server CPU-seconds and ~25 cumulative FFmpeg CPU-seconds with ~236 MiB sampled simultaneous FFmpeg RSS; brief FFprobe processes and I/O can be missed. The ~0 physical read bytes reported during warm runs do not establish cold-disk performance. Collect a profiler or per-phase telemetry before attributing CPU precisely.

## Follow-up measurements after indexed browsing (same local machine)

The catalog stores each file's opaque direct-parent folder ID and active ancestor folders during authoritative `Sync`; root removal and empty rescans hide folders together with media. `Browse` reads the direct-child folder index and a bounded item page rather than scanning the library. The schema contract and the forward migration `010_media_folders.sql` define both indexes; historical migrations remain unchanged so existing databases are upgraded with their media backfilled atomically. `TestMediaBrowseUsesParentIndexes` asserts that `EXPLAIN QUERY PLAN` selects `media_folders_available_parent_id` for folder children and `media_available_parent_id` for items with `available`, parent and cursor predicates. Existing opaque IDs, ordering, pagination and availability behavior are covered by database tests.

| Scenario | Before p95 ms | After p95 ms | Samples |
| --- | ---: | ---: | ---: |
| Root tree, 100 records, 1 client | 0.635 | 0.388 | 100 |
| Root tree, 1,000 records, 1 client | 2.611 | 0.394 | 100 |
| Root tree, 5,000 records, 1 client | 10.535 | 0.443 | 100 |
| Deep tree, 5,000 records, 1 client | 12.381 | 0.408 | 100 |
| Root tree, 5,000 records, 2 clients | 18.112 | 0.611 | 100 |
| First list page, 5,000 records, 1 client | 0.734 | 0.804 | 100 |

After the final sync-loop cleanup, one `testing.B` run (five operations per size, setup excluded) returned ~62–145 µs/op for five-item root/deep browse at 100–10,000 records, without a rising per-row trend; unchanged `Sync` ranged from ~37k items/s at 100 to ~33k items/s at 10,000 synthetic records. With 200 operations per case on 5,000 rows, the separate deep-browse connection benchmark observed 0 waits/op and 0 wait ns/op for one caller versus 0.995 waits/op and 47,902 wait ns/op for two callers (52,316 vs 48,064 ns/op respectively). Waits are expected with the single-connection pool; this synthetic two-caller snapshot is **not** a reason to change pool size without representative mixed workloads. These small samples are sanity checks, not confidence intervals; browse's extra folder writes make `Sync` cost worth watching at larger folder cardinalities. HTTP measurements were from a single post-change run with the same workload shape as baseline, not controlled paired runs. The API resource sidecar observed server CPU of 0.47–0.50 s per 100-request-per-scenario phase, sampled peak RSS ~27–29 MiB; it did not count seed CPU. No error rows were reported.

Further media experiments used the same verified Sintel fixture. A three-repeat 2 s hit GET p50 of 18.797 ms and validated HEAD p50 of 19.429 ms show little transfer cost at this size; a validation/process trace is needed before changing safe cache validation. One default media run with 100 primed waveform specs returned p50 0.714 ms for last-spec repeat; 1,000 specs in a separate run returned 1.751 ms (three samples each). Residency is not observable from HTTP, and the runs have different cache histories: **do not infer an eviction regression from that comparison alone**.

The optional linked-file scan showed 101 files imported in 1.677 s and rescanned in 1.657 s; 1,001 files imported in 16.668 s and rescanned in 16.661 s (one scan each; ~60 indexed files/s). The 1,001-file run sampled ~2.06 server CPU-seconds and saw 1,329 short FFprobe processes, but could not reliably count their CPU; the individual repeated probes, not just SQL sync, are implicated. Hardlinks share bytes/inode and do not model independent recordings. With output bytes checked and downloaded outputs validated by FFprobe, two 4 s segments took p50 146.552 ms stream-copy vs 893.089 ms precise re-encode; two 16 s segments took 166.741 ms vs 2121.842 ms (three runs per strategy/profile). The latter run sampled ~51.25 cumulative FFmpeg CPU-seconds across the entire media phase, not specifically exports. Quality, alternate codecs and cold storage were not assessed.

## Next prioritized experiments

1. **Preserve browse gains under real catalog shape.** Repeat paired API runs on more/deeper folder layouts and measure connection waits under representative mixed browse/write traffic before altering the intentional single-connection setting. Profile scan publication when thousands of distinct folders accompany files; only change the folder-write strategy if measured sync cost warrants it.
2. **Investigate scan probe budget with identity rules.** Split large real-file scans into directory walk, source verification, FFprobe and SQLite durations. Repeat on heterogeneous codecs, SSD and slower storage; evaluate bounded parallel probes only against CPU/RSS, cancellation, file-descriptor and scan-limit safety. Avoid silently skipping source validation based solely on size/mtime.
3. **Profile safe cache paths.** Instrument preview validation and cache eviction separately; repeat proven GET/HEAD hits with larger files and cache cardinalities. Re-run asset cardinality under a known cache budget with verified residence/evictions. Keep corruption and source-change detection; do not bypass FFprobe merely to lower warm-hit latency.
4. **Keep export semantics and resource limits explicit.** Compare verified outputs across codecs, resolutions, lengths and encoder profiles with objective quality criteria, process CPU/RSS and throughput. Only enable hardware acceleration after a real probe transcode. Never trade frame-accurate cuts for stream-copy performance without an explicit mode change.
5. **Strengthen benchmark reproducibility without gating on timing.** Repeat whole paired runs, capture setup wall time and a per-workflow resource split beyond `media_run`; supplement the sampling sidecar with a profiler where short processes are missed. Keep real-media downloads and machine-specific thresholds outside `make smoke`.
