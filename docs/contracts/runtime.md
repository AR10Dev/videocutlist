# Frozen Runtime Contracts — v1

## Identity and media

- Go module: `editapp`.
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

- Projects are owned by normalized Tailscale login. Cross-owner access returns
  404. Revision zero creates; successful PUT increments revision; stale
  revisions return 409.
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

- Production mode accepts Tailscale identity/capability headers only from
  configured trusted-proxy CIDRs while listening on loopback.
- Preview, export, and media-refresh actions require a matching forwarded
  capability grant in production mode. Development mode bypasses grants.
- The default trusted proxies are `127.0.0.0/8,::1/128`.
- Development mode requires `EDITAPP_DEV_USER_LOGIN`, refuses non-loopback
  binding, and synthesizes only that identity.
- Local OS users able to connect to the loopback port are inside the proxy
  trust boundary. Funnel is forbidden.

## Cancellation and streaming

- HTTP request context cancellation detaches that subscriber.
- A newer foreground request supersedes the same user's previous subscription.
- Identical normalized previews share one process. The process is cancelled
  when no subscribers remain.
- A shared preview retains at most 64 MiB for replay to late subscribers.
- FFmpeg receives SIGTERM, a bounded grace period, then forced termination.
- Streaming begins from stdout without waiting for process completion.
- Cache completion requires FFmpeg success and FFprobe validation.

## Configuration

All settings use environment variables:

```text
EDITAPP_LISTEN_ADDR=127.0.0.1:8787
EDITAPP_DATABASE_PATH
EDITAPP_CACHE_DIR
EDITAPP_EXPORT_DIR
EDITAPP_MEDIA_ROOTS_JSON
EDITAPP_AUTH_MODE=tailscale|dev
EDITAPP_DEV_USER_LOGIN
EDITAPP_TRUSTED_PROXY_CIDRS
EDITAPP_FFMPEG_PATH
EDITAPP_FFPROBE_PATH
EDITAPP_PREVIEW_GLOBAL_LIMIT
EDITAPP_PREVIEW_PER_USER_LIMIT
EDITAPP_EXPORT_LIMIT
EDITAPP_CACHE_MAX_BYTES
EDITAPP_PREVIEW_BEFORE_MS
EDITAPP_PREVIEW_AFTER_MS
EDITAPP_PREVIEW_MAX_MS
EDITAPP_PREVIEW_GRID_MS
EDITAPP_ENCODER_PREFERENCE
EDITAPP_LOG_LEVEL
```

## Logging and metrics

Structured JSON fields are: `request_id`, `user_login`, `media_id`,
`project_id`, `job_id`, `cache_key`, `cache_status`, `preview_start_ms`,
`preview_duration_ms`, `encoder_profile`, `ffmpeg_pid`, `queue_wait_ms`,
`spawn_to_first_byte_ms`, `total_job_ms`, `bytes_streamed`, `cancel_reason`,
and `error_code`.

Metrics use the exact names in the implementation prompt. Labels are restricted
to bounded route templates, methods, status classes, cache state, cancellation
reason, and encoder profile. Paths and unique IDs are never labels.
