# Browser fault scenarios

Keep these tests deterministic by routing only the preview request in
Playwright; do not depend on a live connectivity-provider path.

| Scenario | Route behavior | Browser assertion |
| --- | --- | --- |
| Stale selection | Hold preview A after its first chunk; fulfill B first | Player state and displayed offset belong to B, never A. |
| Abort | Stream A, create selection B | A request is aborted or ignored before it changes playback state. |
| Interrupted stream | Close body after initialization bytes | Error state is visible and a later valid selection recovers. |
| Unsupported MIME | Return a MIME rejected by `MediaSource.isTypeSupported()` | No append attempt; accessible error is shown. |
| Server error | Return safe 5xx envelope | Error is rendered without exposing media paths. |

Use the generated `avc-aac.mp4` fixture for valid bytes and record Playwright
traces on retry. Add concrete specs alongside the application test setup; this
directory intentionally has no test runner configuration of its own.
