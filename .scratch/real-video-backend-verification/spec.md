# Real-video backend verification

**Status:** complete — all acceptance workflows verified by the opt-in real-media suite

## Problem

The backend has unit and integration tests, including FFmpeg-generated fixtures, but there is no single black-box test that starts the production application and drives a downloaded, natural video through the complete backend workflow. Several integration tests also skip when FFmpeg is unavailable. A passing default test run therefore does not prove that media indexing, preview generation, derived assets, detection, project persistence, durable jobs, and export work together with the host's real FFmpeg installation.

## Outcome

One opt-in test command downloads a small public video into an ignored directory under `test/`, verifies its checksum, starts the real VideoCutlist process with isolated storage, and exercises every public backend capability.

The command fails if a required executable is missing, an endpoint is untested, a job does not reach the expected state, generated media does not pass FFprobe validation, a temporary artifact remains, or an HTTP response exposes an original-media path.

## Meaning of complete backend coverage

"Every backend capability" means every route accepted by the production HTTP router, plus process startup, shutdown, restart recovery, persistence, authentication modes, CORS, trusted-proxy handling, metrics, and static application delivery. It does not mean every possible input combination or every private Go function.

Each route must have at least one successful or expected lifecycle test. Trust boundaries and destructive operations must also have a rejection or cancellation test. Existing focused unit tests remain responsible for exhaustive validation rules and parser edge cases.

## Downloaded fixture

Use the Sintel trailer hosted by W3C:

- URL: `https://media.w3.org/2010/05/sintel/trailer.mp4`
- Local path: `test/fixtures/real-media/sintel-trailer.mp4`
- SHA-256: `b670602fa00934ca27c4351bb0efe7ea7a07fae57284e44226025eeed7c51254`
- Expected size: 4,372,373 bytes
- Expected media: 52.208 seconds, H.264 video at 854 by 480 and 24 fps, AAC audio, MP4 container
- Source work: Sintel by Blender Foundation, licensed under CC BY 3.0

The media file must not be committed. Add the fixture directory to `.gitignore`. Commit a short attribution file beside the downloader, not beside the ignored download if that would also ignore the attribution.

A fixture command must:

1. Reuse the local file when its SHA-256 matches.
2. Download to a temporary file with redirects enabled and a bounded timeout.
3. reject a checksum mismatch and delete the bad temporary file.
4. Publish the verified file by atomic rename.
5. Avoid replacing a valid cached copy after a network failure.

The test command may use the cached fixture without network access. A first run without network access must fail with a direct message that names the fixture command.

Keep `test/harness/generate-fixtures.sh`. Generated fixtures cover deterministic codec, stream-layout, corruption, black-frame, silence, scene-change, and cancellation cases that one natural video cannot guarantee. The downloaded trailer covers the production process and normal user workflow.

## Test boundary

The black-box suite must build and start `cmd/videocutlist`. It must not instantiate HTTP handlers or replace FFmpeg, FFprobe, the database, scheduler, media catalog, cache, or export service with stubs.

Each run uses temporary directories for:

- SQLite database
- media root
- preview and derived-asset cache
- exports
- downloaded-output inspection

Copy or link the verified fixture into the temporary media root before startup. The application receives only that root through `VIDEOCUTLIST_MEDIA_ROOTS_JSON`. Tests discover the opaque media ID through the API and never construct it from or retrieve an original path.

Reserve a loopback port through the operating system. Do not hard-code a port. Wait for `/api/v1/ready` with a deadline, capture process logs, and always terminate the process. A failed test must print the bounded server log and keep no child FFmpeg processes.

Run the main workflow with bearer authentication on `127.0.0.1`. Use separate short-lived process runs for behavior that requires another deployment mode, such as `auth=none`, trusted proxy, and restart recovery.

## Core workflow

The suite must prove this sequence against one running production process:

1. Read health and readiness.
2. Wait for the initial library scan or start a refresh, then wait for its durable job to succeed.
3. List and browse media, obtain the fixture's opaque ID, and read its metadata.
4. Generate a preview, thumbnails, and waveform. Repeat cacheable requests and prove a cache hit.
5. Create and read a project containing the media item and two non-overlapping segments.
6. Export and import the item's segments as CSV and chapter text.
7. Run silence, black, and scene detection jobs and wait for successful terminal states. Empty candidates are valid for the natural fixture, but each returned candidate must be in bounds.
8. Run export preflight.
9. Submit batch exports, inspect batch and job progress, download retained output, and validate it with FFprobe.
10. Read and update runtime settings using revision control, then prove persistence after restart.
11. Exercise the loopback automation endpoint with authenticated commands.
12. Read metrics and confirm that the completed operations appear without paths or opaque IDs as labels.
13. Shut down cleanly, restart with the same database, and prove projects, settings, media records, and terminal jobs remain readable.

Polling must use a deadline and a small bounded interval. A timeout reports the last response body and captured process log.

## Route coverage matrix

The implementation must keep a table that accounts for every route accepted by `internal/httpapi/routes.go`. Adding a route without adding a test case must fail a route-coverage check.

### Process and observability

- `GET /api/v1/health` returns success while the process is alive.
- `GET /api/v1/ready` returns success after SQLite and runtime dependencies are ready.
- `GET /metrics` returns Prometheus text and includes request and job observations produced by this suite.
- `GET /` returns the application document from the production static handler.

### Media library

- `GET /api/v1/media/status` reaches `ready_with_media` after scanning.
- `GET /api/v1/media` returns the Sintel fixture with no filesystem path.
- `GET /api/v1/media/tree` returns the root and media item. Folder browsing is exercised when a nested fixture directory is used.
- `GET /api/v1/media/{mediaId}` returns duration, size, container, streams, and ETag matching FFprobe within documented rounding.
- `POST /api/v1/media/refresh` returns a durable library-scan job that succeeds.
- `POST /api/v1/settings/media/refresh` exercises the settings alias for refresh.
- `POST /api/v1/media/import` starts an import job.
- `GET /api/v1/media/import/{jobId}` reads that job.
- `DELETE /api/v1/media/import/{jobId}` cancels a deliberately queued or running import, or returns the documented terminal behavior if it completes first.

### Preview and derived assets

- `HEAD /api/v1/media/{mediaId}/preview` misses before generation and succeeds after publication.
- `GET /api/v1/media/{mediaId}/preview` returns a playable fragmented MP4 with correct preview headers. FFprobe validates the bytes.
- A second identical preview request reports a cache hit.
- A preview near each file boundary reports a clamped window containing the requested playhead.
- Closing a cache-miss preview response cancels FFmpeg and publishes no partial cache file.
- `GET /api/v1/media/{mediaId}/thumbnails` returns a valid image payload and then a cache hit.
- `GET /api/v1/media/{mediaId}/waveform` returns bounded numeric samples and then a cache hit.
- Conditional asset requests exercise ETag or not-modified behavior where supported.

### Projects and interchange

- `PUT /api/v1/projects/{projectId}` creates a project at revision zero and updates it at the returned revision.
- A stale project update returns `409` and leaves the saved project unchanged.
- `GET /api/v1/projects/{projectId}` returns the saved project.
- `GET /api/v1/projects` lists it and exercises pagination input.
- `GET /api/v1/projects/{projectId}/interchange/csv` and `/chapters` export the selected item's segments.
- `POST /api/v1/projects/{projectId}/interchange/csv` and `/chapters` import valid data and increment the project revision.
- Invalid or out-of-bounds interchange input returns a safe `422` response and does not mutate the project.

### Detection

- `POST /api/v1/projects/{projectId}/detections` runs `silence`, `black`, and `scene` detection through the real FFmpeg binary.
- Each accepted request returns a durable job readable through the jobs API.
- Every candidate has the requested media ID, project ID and revision, source kind, bounded times, and bounded confidence.
- A stale source fingerprint or project revision fails with the documented safe error and does not apply candidates to the project.

### Export, batches, jobs, and outputs

- `POST /api/v1/projects/{projectId}/exports/preflight` reports deterministic selection and structured findings.
- `POST /api/v1/projects/{projectId}/exports` covers merge and separate modes, segment and gap selection, and every supported cut strategy.
- The downloaded fixture is used for the normal merge export. Existing deterministic generated fixtures cover keyframe-aligned, non-keyframe, hybrid fallback, and unsupported-codec behavior.
- `GET /api/v1/batches` lists submitted batches.
- `GET /api/v1/batches/{batchId}` reports monotonic progress and the final derived state.
- `DELETE /api/v1/batches/{batchId}` cancels a queued or running batch and leaves no published or temporary output.
- `GET /api/v1/jobs/{jobId}` reports safe public state and metadata.
- `DELETE /api/v1/jobs/{jobId}` is idempotent for terminal jobs and cancels non-terminal work.
- `POST /api/v1/jobs/{jobId}/retry` creates a new batch only for an eligible failed export job.
- `GET /api/v1/jobs/{jobId}/outputs/{position}` downloads each retained output and rejects invalid positions or ineligible jobs.
- FFprobe opens every successful output. Duration is plausible for the selected ranges, selected streams are present, and no `.partial` or temporary export remains.
- Stream-copy results retain the documented non-keyframe warning. Tests must not call them frame-exact.

### Destinations and settings

- `GET /api/v1/destinations` returns safe IDs, labels, kinds, and retention without root paths.
- `GET /api/v1/settings` returns runtime values, revision, schema version, and safe root diagnostics without raw paths.
- `PUT /api/v1/settings` updates mutable runtime values and takes effect without restart.
- A stale settings revision returns `409`.
- Attempts to mutate deployment-only settings return `422` or `403` as documented and change neither runtime nor persistence.
- Restarting with the same database preserves the successful runtime update.

### Automation

- `POST /api/v1/automation` runs `project.import`, `project.export`, and `job.status` on loopback with bearer authentication.
- Missing authentication, an `Origin` header, malformed input, unknown fields, oversized input, and an unsupported command are rejected safely.
- Automation responses contain only opaque IDs, safe filenames, content, and public job fields.

## Security and failure checks

The real-media suite supplements, rather than duplicates, exhaustive unit tests. It must still prove the following through the production process:

- Bearer mode rejects a missing or bad token before application work runs.
- `auth=none` starts only on loopback.
- Trusted-proxy mode ignores forwarded headers from untrusted peers and accepts validated data only from configured proxy CIDRs.
- Allowed CORS preflight succeeds before authentication. Disallowed origins fail.
- Unknown routes, methods, query keys, malformed opaque IDs, oversized bodies, and malformed JSON return bounded safe errors.
- Symlinks escaping the configured media root are never indexed or opened.
- No JSON body, response header, metric label, or structured log contains the temporary media-root path, source path, database path, cache path, or export path.
- Removing or changing the source after indexing causes the documented source-change failure instead of exporting different bytes.
- Cancelling preview, detection, scan, and export work removes incomplete files and terminates child processes.
- Restart converts unreconciled running jobs to `interrupted_by_restart` while queued jobs remain eligible to run.

## Commands and CI policy

Add one explicit command, named `make test-real-media`, for fixture acquisition and the full black-box suite. It must run serially and fail rather than skip when FFmpeg, FFprobe, networking on first download, or required encoders are unavailable.

Do not add network access to `make test` or `make check`. CI may run `make test-real-media` in a separate job with FFmpeg installed and the fixture directory cached by checksum. `make smoke` may call it only in an environment that explicitly opts into networked real-media tests.

The existing generated-media integration tests remain in the normal Go test suite. Shared fixture and polling helpers should stay small and live under `test/harness` or the black-box test package. Do not introduce a test framework or downloader dependency.

## Evidence produced by a passing run

The command prints a compact summary containing:

- fixture checksum and FFprobe summary
- tested server version or commit
- number of accounted routes
- project ID, batch IDs, and job terminal states
- preview, thumbnail, and waveform cache miss-to-hit results
- exported output names, sizes, durations, and stream summaries
- restart and cancellation results

The summary must not print filesystem paths. Temporary files are removed whether the test passes or fails.

## Acceptance criteria

- [x] A verified Sintel trailer downloads on demand beneath ignored `test/fixtures/real-media/` storage and is never committed.
- [x] `make test-real-media` starts the production application and uses real FFmpeg, FFprobe, SQLite, scheduler, cache, and filesystem adapters.
- [x] The route coverage table accounts for every route accepted by the production router, including routes absent from the current OpenAPI document.
- [x] All route groups in this specification pass through HTTP against the running process.
- [x] The downloaded video completes indexing, preview, thumbnail, waveform, project, interchange, detection, preflight, export, download, and restart workflows.
- [x] Every successful media artifact passes FFprobe or format-specific validation.
- [x] Cache tests prove miss, atomic publication, hit, and cancellation cleanup.
- [x] Durable scan, detection, export, retry, and cancellation behavior reaches the expected terminal states within fixed deadlines.
- [x] Authentication, CORS, trusted-proxy, path confinement, request validation, and response redaction checks pass.
- [x] Tests fail instead of skip when required real-media prerequisites are unavailable.
- [x] No original media, generated preview, export, cache, SQLite database, or test worktree is committed.
- [x] Existing `make check`, `make test`, and `make smoke` behavior remains deterministic unless real-media testing is explicitly enabled.

## Verification note

The integration suite accounts for all 31 production route kinds (34 method/path variants) and the three process/static endpoints through runtime request accounting. Stream-copy verification allows bounded timestamp drift from concatenation while rejecting implausible output and preserves the non-keyframe warning. The natural MP4 hybrid case is an expected safe failure with retry eligibility; generated fixtures cover hybrid success and fallback. `make test-real-media` passes with the verified fixture cache hit; no generated media, output, cache, database, or worktree files are committed.

## Out of scope

- Browser interaction and visual behavior. Playwright remains responsible for those.
- Exhaustive testing of every numeric boundary or malformed payload. Focused unit tests remain responsible for that.
- Network streaming, remote media roots, cloud storage, multiple server instances, or hardware encoders.
- Benchmarking quality, encoding speed, or exact visual equivalence.
- Committing downloaded or generated media to Git.
