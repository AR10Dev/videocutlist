# Test plan

## Scope and execution

This plan supplies deterministic media inputs and fault seams for the MVP. It
does not add product behavior or regression limits. Generate disposable media
outside the repository, then run:

```bash
test/harness/assert-fixtures.sh
test/faults/verify-fake-ffmpeg-cleanup.sh
test/performance/assert-measure-command.sh
```

The fixture generator requires FFmpeg/FFprobe 6.1 and software `libx264`.
It deliberately requires no GPU encoder: hardware is unavailable in the
controller environment and must be tested only as a failing-to-software-fallback path.

## Cross-format matrix

| Fixture | Container/codecs | Metadata | Software preview | Export coverage |
| --- | --- | --- | --- | --- |
| `avc-aac.mp4` | MP4 / H.264 + AAC | duration, dimensions, audio | valid fMP4 | compatible stream-copy baseline |
| `avc-aac.mkv` | Matroska / H.264 + AAC | container normalization | valid fMP4 | compatible stream-copy baseline |
| `avc-aac.mov` | MOV / H.264 + AAC | container normalization | valid fMP4 | compatible stream-copy baseline |
| `avc-video-only-long-gop.mp4` | MP4 / H.264 only, 2 s GOP | audio absent | valid silent fMP4 | keyframe-warning path |
| `portrait-avc-aac.mp4` | MP4 / 180x320 H.264 + AAC | portrait dimensions | valid fMP4 | compatible stream-copy baseline |
| `unusual-dimensions-avc-aac.mp4` | MP4 / 318x178 H.264 + AAC | non-standard even dimensions | normalized 1280x720 fMP4 | compatible stream-copy baseline |
| `multi-audio-avc-aac.mkv` | Matroska / H.264 + two AAC streams | streams and language tags | selected/default audio behavior | compatible stream-copy baseline |
| `vfr-avc-video-only.mp4` | MP4 / variable-frame-rate H.264 | differing nominal/average frame rates | normalized 30 fps fMP4 | keyframe-warning path |
| `very-short-avc-aac.mp4` | MP4 / 100 ms H.264 + AAC | duration below usual window | boundary-clamped fMP4 | valid short export or safe error |
| `vp9-opus.webm` | WebM / VP9 + Opus | non-baseline codecs | normalized H.264/AAC fMP4 | unsupported-copy warning or rejection |
| `hevc-aac.mkv` | Matroska / HEVC + AAC | HEVC metadata | normalized H.264/AAC fMP4 | stream-copy eligibility/warnings |
| `av1-aac.mkv` | Matroska / AV1 + AAC | AV1 metadata | normalized H.264/AAC fMP4 | unsupported-copy warning or rejection |
| `audio-only.wav` | WAV / PCM | video absent | safe validation error | safe validation error |
| `corrupt-truncated.mp4` | truncated MP4 | probe fails safely | no process/publish | no process/output |

The generated visual and audio signals, duration, frame rate, GOP, and command
arguments are fixed. Byte equality is only expected under the same FFmpeg build;
tests validate with FFprobe rather than committing machine-generated media.
`libx264` and AAC are the base requirement. WebM, HEVC, and AV1 are optional:
when `libvpx-vp9`/`libopus`, `libx265`, or `libaom-av1` is unavailable, the
generator records an explicit `skipped` row in `fixture-status.tsv` and the
base harness still passes. CI should retain that status file with its test
artifacts and run optional rows whenever their encoder is present.

## Cancellation and cleanup

Each API-level cancellation test sets `VIDEOCUTLIST_FFMPEG_PATH` to the absolute
path of `test/harness/fake-ffmpeg.sh` and `VIDEOCUTLIST_TEST_PID_FILE` to a temporary
file. After an HTTP disconnect or superseding request, poll both PIDs in that
file until they have exited. The request must first receive the initial bytes,
which proves cancellation is not merely a pre-spawn shortcut. Also assert that
the cache contains neither a completed entry nor a `.partial` for the cancelled
key. Test duplicate normalized requests separately: one PID, two subscribers.

## Fault coverage

The complete setup/assertion table is in [test/faults/README.md](../test/faults/README.md).
Run fault tests in per-test temporary cache and export directories. Permission
tests must restore permissions in cleanup; disk-full tests use the fake
subprocess `enospc` mode rather than filling a real filesystem.

## Performance record format

Use `test/performance/measure-command.sh` once per scenario and retain raw CSV
records outside git. Its header is:

```text
started_utc,scenario,source_format,encoder_profile,cache_state,wall_ms,exit_status,stdout_bytes,stderr_bytes
```

Pair these records with the service's structured `spawn_to_first_byte_ms`,
`total_job_ms`, `queue_wait_ms`, and `bytes_streamed` fields when available.
Record host CPU model, FFmpeg version, input fixture, client network path, and
whether the cache was warm. Do not gate CI on a number until repeated stable
measurements establish an approved baseline.

## Layer ownership

| Layer | Focus |
| --- | --- |
| Unit | Normalization, cache identity, path containment, revisions, and state transitions. |
| FFmpeg integration | Matrix fixtures, probe/preview validity, atomic cache publication, stream-copy warnings, cancellation. |
| API integration | Authorization before spawn, disconnect/supersession, deduplication, safe errors and metrics. |
| Browser | MSE MIME checks, returned offset, rapid reselection, recovery from interruption. |
