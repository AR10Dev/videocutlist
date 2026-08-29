# Frozen Runtime Contracts — v1

## Settings scopes and administration

VideoCutlist has three settings scopes:

- **Deployment bootstrap (environment-only):** database path, listener and port,
  authentication, trusted proxy and CORS policy, FFmpeg/FFprobe paths, and
  container mounts. These values are never editable through the Settings API.
- **Server runtime settings (shared by every client):** media roots, export
  defaults and destinations, preview limits, cache policy, and scan limits.
  These values use a typed persisted document; deployment values provide first-run
  defaults only.
- **Browser preferences (local to one browser profile):** editor conveniences
  such as mute, cut strategy, and filename template. They are stored in browser
  local storage and are never sent to the server settings store.

The Settings API is a shared single-user operation. Its HTTP handlers run only
after the deployment access gate. The local `auth=none` mode is loopback-only; a
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
- Profile `software-h264-v1`: at most 1280x720, 30 fps, H.264 libx264,
  yuv420p, AAC stereo 48 kHz, fragmented MP4.

## Cache key

Hash compact JSON serialized in this fixed field order:

```json
{"v":1,"media":{"id":"","sizeBytes":0,"mtimeNs":0},"preview":{"startMs":0,"durationMs":0,"width":1280,"height":720,"fps":30,"audio":true,"videoCodec":"h264","audioCodec":"aac","mux":"fmp4"},"encoder":{"profile":"software-h264-v1"}}
```

Use lowercase SHA-256 hex and `previews/<0:2>/<2:4>/<hash>.mp4`.
Incomplete files end in `.partial`; only atomic rename publishes a hit.

## Projects and jobs

- Projects are single-user resources. Revision zero creates; successful PUT
  increments revision; stale revisions return 409.
- Segment bounds are non-negative, ordered, non-overlapping, within the media
  duration, and `startMs < endMs`.
- Job states: `queued`, `running`, `succeeded`, `failed`, `cancelled`.
  Terminal states never transition.
- Export capacity is admission-controlled before a durable job is created;
  excess submissions return HTTP 429 rather than forming an unbounded queue.
- On restart, both `queued` and `running` jobs become failed with
  `interrupted_by_restart`.
- MVP exports use MKV and `stream_copy_preferred`; no smart-boundary re-encode.
  Non-keyframe accuracy limitations are explicit structured warnings.

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

All settings use environment variables:

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
VIDEOCUTLIST_MEDIA_ROOTS_JSON
VIDEOCUTLIST_AUTH_MODE=none|bearer|trusted_proxy
VIDEOCUTLIST_BEARER_TOKEN
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

Public base URLs and allowed origins accept only absolute HTTP(S) values
without credentials, query, or fragment; origins also have no path.
`VIDEOCUTLIST_ALLOWED_ORIGINS` is comma-separated and empty by default. CORS is
deny-by-default: requests without `Origin` remain ordinary same-origin or
non-browser requests, while a request with `Origin` must exactly match the
configured list. Allowed responses echo that origin, set
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

Server middleware order is CORS, then trusted-proxy parsing, then the API/static
handler. No connectivity-provider header or address rule participates in this
layer.

Read and idle timeouts must be positive Go durations. Write timeout may be
zero so streamed previews are not terminated by a whole-response deadline.

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

## Logging and metrics

Structured JSON fields are: `request_id`, `media_id`,
`project_id`, `job_id`, `cache_key`, `cache_status`, `preview_start_ms`,
`preview_duration_ms`, `encoder_profile`, `ffmpeg_pid`, `queue_wait_ms`,
`spawn_to_first_byte_ms`, `total_job_ms`, `bytes_streamed`, `cancel_reason`,
and `error_code`.

Metrics use the exact names in the implementation prompt. Labels are restricted
to bounded route templates, methods, status classes, cache state, cancellation
reason, and encoder profile. Paths and unique IDs are never labels.
