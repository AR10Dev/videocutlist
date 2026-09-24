# Frozen runtime contracts - v2

## Settings scopes and administration

VideoCutlist has three settings scopes:

- **Deployment bootstrap (environment-only):** database path, listener and port,
  authentication, trusted proxy and CORS policy, FFmpeg/FFprobe paths, and
  container mounts. These values are never editable through the Settings API.
- **Server runtime settings (shared by every client):** safe export defaults,
  destination labels and retention, preview limits, cache policy, and scan limits.
  Filesystem paths, mounts, executables, and listener settings remain deployment-only.
- **Browser preferences (local to one browser profile):** editor conveniences
  such as mute, cut strategy, and filename template. They are stored in browser
  local storage and are never sent to the server settings store.

The Settings API is a shared single-user operation. Its HTTP handlers run only
after the deployment access gate and return safe aliases rather than filesystem
paths. The local `auth=none` mode is loopback-only; a
non-loopback deployment must configure `bearer` or `trusted_proxy` access.

## Access gate and media

- Go module: `videocutlist`.
- A media ID is `m_` plus unpadded base64url SHA-256 of
  `rootAlias + "\x00" + slash-normalized relative path`.
- A source fingerprint is media ID, byte size, and nanosecond mtime.
- The resolver evaluates symlinks and rejects any result outside its configured
  canonical root. API values never contain original paths.

## Preview normalization

- Inputs and outputs use integer milliseconds.
- Defaults: 2,000 before, 6,000 after, 15,000 maximum, 500 cache grid.
- Clamp center into the media duration, grid the center, then shift the window
  at file boundaries while preserving the selected timestamp in the window.
- The exact original selection maps to `X-Preview-Offset`.
- Profile `software-h264-baseline-l31-v2`: at most 1280x720, 30 fps, H.264 libx264
  constrained baseline level 3.1 (`avc1.42C01F`), yuv420p, AAC stereo 48 kHz, fragmented MP4.

## Cache key

Hash compact JSON serialized in this fixed field order:

```json
{"v":1,"media":{"id":"","sizeBytes":0,"mtimeNs":0},"preview":{"startMs":0,"durationMs":0,"width":1280,"height":720,"fps":30,"audio":true,"videoCodec":"h264","audioCodec":"aac","mux":"fmp4"},"encoder":{"profile":"software-h264-baseline-l31-v2"}}
```

Use lowercase SHA-256 hex and `previews/<0:2>/<2:4>/<hash>.mp4`.
Incomplete files end in `.partial`; only atomic rename publishes a hit.
Before cache lookup, preview requests reopen the indexed source beneath its
configured root and verify its size and modification time. Changed sources are
rejected until the catalog is refreshed; cache hits do not bypass this check.
Timeline thumbnails and waveforms enforce the same source-fingerprint check,
including conditional `304` responses. A changed source returns `409
source_changed`; a missing source returns `404 not_found`. Preview capacity
rejection alone returns `429 preview_busy` with `Retry-After: 1`; deadlines
return `504 preview_timeout` (or `asset_timeout` for timeline assets), and
unexpected startup/cache failures return `500`.

## Projects and jobs

- Projects contain ordered media items. Each item has a stable opaque ID,
  independent segments, editor state, and export options. Revision zero creates;
  successful PUT increments revision; stale revisions return 409.
- Segments persist a stable `id`, integer-millisecond `startMs`/`endMs`, optional
  `label`, and `included` state. Documents written before `included` existed
  default legacy segments to included. CSV and chapter interchange preserves
  timing and labels only; it does not carry segment identity or inclusion, so
  imported rows default to included and exports cannot promise that metadata
  round-trips through those formats.
- Segment bounds are non-negative, ordered, non-overlapping, within each item's
  media duration, and `startMs < endMs`.
- Export, detection, and library-scan jobs use one durable SQLite state machine:
  `queued`, `running`, `succeeded`, `failed`, `cancelled`. Terminal states never
  transition, and batch state is derived from child jobs.
- Queue admission and insertion are atomic. Queue capacity is independent from
  worker concurrency; excess submissions return HTTP 429.
- On restart, queued jobs remain queued. Running jobs become failed with
  `interrupted_by_restart` unless artifact reconciliation proves completion.
  Graceful shutdown also fails interrupted active work with this code rather
  than reporting a user cancellation. Already-published durable results still
  win shutdown; explicit user cancellation remains a terminal CAS.
- MVP exports use MKV and `stream_copy_preferred`; no smart-boundary re-encode.
  Non-keyframe accuracy limitations are explicit structured warnings. Publication
  requires a descriptor-relative atomic no-replace rename: Linux uses
  `renameat2(RENAME_NOREPLACE)` and macOS uses `renameatx_np(RENAME_EXCL)`.
  On other platforms, both `merge` and `separate` exports are blocked during
  preflight with `unsupported_publication_platform` before FFmpeg starts; the
  implementation does not fall back to a raceable check-then-rename or a
  hard-link publication.

## Editing workspace

- In and Out marks are an incomplete draft until both bounds are valid. A valid,
  non-overlapping range commits exactly one selected segment named `Segment NNN`;
  marking again edits that segment instead of creating a duplicate. **New
  segment** and Escape clear the selection and begin a new draft.
- Segment rows and source-timeline ranges share stable segment identity. Rows
  expose inclusion, naming, bounds, duration, selection, and deletion without
  changing the integer-millisecond, non-overlap invariants. The included count
  and requested duration summarize the selected export scope; they do not claim
  frame-exact stream-copy output duration.
- Panel widths, collapse state, waveform visibility, and loop preference are
  browser-local preferences. Separators expose vertical separator semantics,
  keyboard adjustment, and reset actions. At widths below 1050px, media and
  task panels use mutually exclusive drawers; at 1050px and above the desktop
  layout remains available. Narrow drawer close actions restore their trigger
  focus.
- Missing thumbnails, waveform data, source keyframe timestamps, audio tracks,
  or MediaSource preview support are non-blocking capability states. Editing,
  saving, and export eligibility remain available when a preview asset is
  unavailable, with a retry or explanatory status where applicable.
- Export requests use a successfully saved project revision and immutable job
  snapshots. Export scope excludes segments marked `included: false`; preflight
  and stream-copy limitations are reported before submission. Browser requests
  identify media and destinations by opaque IDs and never carry original-media
  filesystem paths.
- Segment labels use the same 200-Unicode-code-point limit in browser and
  server validation. Slashes and backslashes in labels are ordinary text,
  including CSV/chapter interchange; they are not filesystem paths.

## Authentication

Authentication is a deployment access gate, not an application identity system.
Modes are `none`, `bearer`, and `trusted_proxy`; the gate returns only success or
failure. `none` is restricted to loopback listeners. Bearer tokens use constant-
time comparison, and trusted proxy mode consumes only validated proxy context.
Failed authentication returns before application services run.

## Cancellation and streaming

- Each preview request is independent: a cache miss starts one FFmpeg process
  and does not share, replay, or single-flight another request.
- HTTP request cancellation, or closing the response stream, cancels FFmpeg and
  discards the incomplete cache output.
- FFmpeg receives SIGTERM, a bounded grace period, then forced termination.
- Streaming begins from stdout without waiting for process completion.
- Cache completion requires FFmpeg success and FFprobe validation, followed by
  atomic publication; incomplete `.partial` files are never cache hits.

## Configuration

Environment variables configure deployment settings and seed runtime settings
when the database is new:

```text
VIDEOCUTLIST_LISTEN_ADDRESS=127.0.0.1
VIDEOCUTLIST_PORT=8787
VIDEOCUTLIST_PUBLIC_BASE_URL
VIDEOCUTLIST_ALLOWED_ORIGINS
VIDEOCUTLIST_READ_TIMEOUT=15s
VIDEOCUTLIST_WRITE_TIMEOUT=0s
VIDEOCUTLIST_IDLE_TIMEOUT=60s
VIDEOCUTLIST_DATABASE_PATH
VIDEOCUTLIST_CACHE_DIR
VIDEOCUTLIST_EXPORT_DIR
VIDEOCUTLIST_DESTINATIONS_JSON
VIDEOCUTLIST_MEDIA_ROOTS_JSON
VIDEOCUTLIST_AUTH_MODE=none|bearer|trusted_proxy
VIDEOCUTLIST_BEARER_TOKEN
VIDEOCUTLIST_MCP_ENABLED=false
VIDEOCUTLIST_TRUSTED_PROXY_CIDRS
VIDEOCUTLIST_FFMPEG_PATH
VIDEOCUTLIST_FFPROBE_PATH
VIDEOCUTLIST_PREVIEW_GLOBAL_LIMIT
VIDEOCUTLIST_EXPORT_LIMIT
VIDEOCUTLIST_CACHE_MAX_BYTES
VIDEOCUTLIST_PREVIEW_BEFORE_MS
VIDEOCUTLIST_PREVIEW_AFTER_MS
VIDEOCUTLIST_PREVIEW_MAX_MS
VIDEOCUTLIST_PREVIEW_GRID_MS
```

Listener addresses are IP literals and are joined to the port with
`net.JoinHostPort`. Production mode permits explicit non-loopback binding;
development mode remains loopback-only.

The Streamable HTTP MCP endpoint is `/mcp` and is disabled unless
`VIDEOCUTLIST_MCP_ENABLED=true`. It implements MCP `2025-06-18`, requires a
separately issued scoped MCP bearer credential on every request, and does not
accept the deployment bearer token. Remote clients require HTTPS; browser
origins must be same-origin or exactly allowed by `VIDEOCUTLIST_ALLOWED_ORIGINS`.

Public base URLs and allowed origins accept only absolute HTTP(S) values
without credentials, query, or fragment; origins also have no path.
`VIDEOCUTLIST_ALLOWED_ORIGINS` is comma-separated and empty by default. Requests
without `Origin` and requests whose origin exactly matches the effective request
origin are same-origin. For trusted proxies this uses validated forwarded
host/protocol; untrusted forwarded headers cannot affect it. Other browser
origins must exactly match the configured list.

`VIDEOCUTLIST_DESTINATIONS_JSON` is an optional, deployment-owned array of typed
export destinations. The default provides `download` (browser download) and
`server` (a durable server-side archive), both rooted at
`VIDEOCUTLIST_EXPORT_DIR`; a custom value replaces these defaults. A
`source_adjacent` entry explicitly enables save-beside-source and must provide
its `mediaRoot`; the browser receives only its opaque ID, label, kind, retention,
and the boolean `capabilities.saveBesideSource`. No destination or media path is
returned. Save-beside-source is unavailable for a source that cannot be
revalidated beneath that configured media root or whose adjacent export folder
is not writable.
An omitted destination resolves only to a configured `download` entry; custom
configurations without one must select a destination explicitly.
Allowed responses echo that origin, set
`Access-Control-Allow-Credentials: true`, vary on `Origin`, and expose
`ETag`, `X-Request-ID`, `X-Preview-Start`, `X-Preview-Duration`,
`X-Preview-Offset`, `X-Preview-Cache`, and `Retry-After`. Wildcard origins are
never emitted.

Allowed preflights require `OPTIONS`, `Origin`, and
`Access-Control-Request-Method`. Methods are limited to `GET`, `HEAD`, `POST`,
`PUT`, and `DELETE`; request headers are limited case-insensitively to
`Authorization`, `Content-Type`, `If-Match`, and `If-None-Match`. Valid
preflights return 204 before authentication. Disallowed or malformed
cross-origin requests return 403 before application services run.

MCP uses a separate CORS policy for `GET`, `POST`, and `DELETE`. It permits
`Authorization`, `Content-Type`, `MCP-Protocol-Version`, and `Mcp-Session-Id`,
and exposes `Mcp-Session-Id` so allowlisted browser clients can establish and
continue Streamable HTTP sessions. This does not expand the REST header policy.

## Trusted reverse proxies

`X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto` are consumed only
when the immediate transport peer belongs to `VIDEOCUTLIST_TRUSTED_PROXY_CIDRS`.
The middleware strips these headers before calling application code and exposes
validated values through request context. Legacy identity headers are stripped
without being interpreted. Untrusted peers retain their transport address,
request host, and transport scheme; forwarded values are ignored.

For trusted peers, client address is selected right-to-left from
`X-Forwarded-For`, skipping configured trusted proxy hops and stopping at the
first untrusted address. Every hop must be an IP literal. Forwarded protocol is
`http` or `https`; forwarded host is a single, bounded,
control-character-free value. Malformed trusted forwarded data returns 400.
The preserved transport peer address is never replaced by forwarded data.

Server middleware parses trusted-proxy context before the route's CORS and
API/static handler. This lets CORS compare the validated public origin behind
TLS termination. No connectivity-provider header or address rule participates.

Read and idle timeouts must be positive Go durations. Write timeout may be
zero so streamed previews are not terminated by a whole-response deadline.

## Source layout

Production code is rooted at `cmd/videocutlist`. SQLite schema and general
persistence live under `internal/db`; durable job persistence and scheduling live
under `internal/jobs`. Feature behavior lives under `internal/library`,
`internal/projects`, `internal/preview`, `internal/export`, `internal/detection`,
`internal/settings`, `internal/httpapi`, and `internal/web`. `internal/runtime`
contains executable-boundary infrastructure composition. The browser entrypoint
is `client/src/App.tsx`; its current application composition and feature helpers
live under `client/src/features` and use generated OpenAPI types.

## Browser client

The browser reads an optional `window.VIDEOCUTLIST_CONFIG` before application module
loading:

```text
serverBaseUrl: absolute HTTP(S) URL
authentication: none | bearer token | cookie
```

When absent, the client uses the current page origin and no authentication.
All application requests resolve beneath the normalized
`<serverBaseUrl>/api/v1/` boundary. Bearer tokens are never read from build-time
environment variables.
On a `401`, the bundled browser offers a bearer-token access form. It verifies
the supplied token against the protected Settings endpoint before reopening
the workspace. The token remains in memory only: no URL, local/session storage,
or generated frontend file stores it. Reloading requires sign-in again.

## Logging and metrics

Structured JSON fields are: `request_id`, `media_id`,
`project_id`, `job_id`, `cache_key`, `cache_status`, `preview_start_ms`,
`preview_duration_ms`, `encoder_profile`, `ffmpeg_pid`, `queue_wait_ms`,
`spawn_to_first_byte_ms`, `total_job_ms`, `bytes_streamed`, `cancel_reason`,
and `error_code`.

The `/metrics` handler exports real HTTP request counts, cumulative latency
sum/count, preview cache hit/miss counts, preview stream read failures, and
HTTP-submitted export job counts. Unsupported active-job, cache-byte, eviction,
stream-byte, and preview-timing gauges/counters are not emitted as fake zeros.
`http_request_duration_seconds` is a Prometheus summary with `_sum` and `_count`
series, not a last-request gauge. Labels use bounded route templates, standard
HTTP methods (unknown methods become `OTHER`), status classes, and cache states;
paths and unique IDs are never labels.
