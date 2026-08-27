# 02: Verify stream selection and output integrity

**What to build:** Executable evidence that export preflight and final verification safely handle representative stream combinations and reject invalid outputs.

**Blocked by:** None (can start immediately)

**Category:** enhancement
**Status:** complete

- [x] Video-only, multi-audio, subtitle, attachment/data, and corrupt-output cases are covered.
- [x] Preflight defaults and blockers are asserted for each case.
- [x] Fast verifier checks cover missing or wrong selected streams, forbidden streams, absent or implausible duration, and corrupt output.
- [x] Generated-media work stays in integration coverage; verifier tests use fake probe results.

## Comments

- Added table-driven preflight coverage and fake-ffprobe verifier cases in `infrastructure/export`.
- Validation: `go test -race ./infrastructure/export` and `make check` passed.
