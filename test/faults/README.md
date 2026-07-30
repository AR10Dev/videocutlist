# Fault harness

`../harness/fake-ffmpeg.sh` is a subprocess fixture, selected by setting
`EDITAPP_FFMPEG_PATH` to its absolute path. Its `EDITAPP_FAKE_FFMPEG_FAIL`
mode is one of `corrupt`, `enospc`, `permission`, or `hardware`; the default
mode writes an initial byte sequence then waits until cancelled.

The product integration tests must use it to make these assertions:

| Scenario | Setup | Required assertion |
| --- | --- | --- |
| Client disconnect | Start default fake process, consume first bytes, cancel request | Recorded parent and child PIDs exit; no cache `.partial` is published. |
| Supersession | Start preview A, request normalized preview B for same user | A exits; B alone may stream. |
| Duplicate request | Start two equivalent normalized requests | One fake-process PID is recorded; both subscribers receive the stream. |
| Interrupted stream | Cancel after first bytes | Response is incomplete; cache lookup is a miss and no completed file exists. |
| Corrupt media | Use `corrupt-truncated.mp4` | No preview hit/publish; structured error is returned. |
| Cache full | `EDITAPP_FAKE_FFMPEG_FAIL=enospc` | Failure is surfaced; partial is removed and prior complete entries remain valid. |
| Permission failure | Use unreadable source or `permission` mode | No output publication; error identifies a safe category, never a source path. |
| Hardware fallback | Select hardware preference and `hardware` mode | Software `libx264` retry succeeds; response/profile reports software. |

`verify-fake-ffmpeg-cleanup.sh` tests only the fixture's signal behavior. The
rows above become product integration tests when the preview API exists.
