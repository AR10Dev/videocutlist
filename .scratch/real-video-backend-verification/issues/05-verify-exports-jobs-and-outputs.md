# 05: Verify exports, batches, jobs, and retained outputs

**What to build:** Real-process tests cover preflight, export selections and strategies, batch/job lifecycle, cancellation, retry, output download, and artifact validation.

**Blocked by:** 02

**Category:** enhancement
**Status:** ready

- [ ] Preflight returns deterministic selection and structured findings.
- [ ] Merge and separate exports cover segment/gap selection and every supported cut strategy without claiming non-keyframe stream-copy is frame-exact.
- [ ] Batch and job APIs report monotonic progress and safe terminal metadata.
- [ ] Cancellation removes partial and published output as documented; terminal job cancellation is idempotent.
- [ ] Eligible failed export retry creates a new batch and ineligible retry is rejected.
- [ ] Every retained output downloads only at valid positions and passes FFprobe stream and duration checks.
- [ ] No `.partial` or temporary export remains.
