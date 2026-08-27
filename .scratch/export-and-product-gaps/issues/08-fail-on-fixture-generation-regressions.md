# 08: Fail on fixture-generation regressions

**What to build:** Make export integration coverage fail when its fixture generator breaks after the required FFmpeg and FFprobe binaries are available.

**Blocked by:** None

**Category:** bug
**Status:** wontfix

- [x] The test skips only when FFmpeg or FFprobe is unavailable.
- [x] A fixture-generator command failure fails the test and includes its output.

## Comments

- Fixture generation now fails the integration test after FFmpeg and FFprobe pass availability checks, preserving command output.
