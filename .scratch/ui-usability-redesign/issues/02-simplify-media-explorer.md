# 02: Simplify the media explorer

**What to build:** Present selectable media using filename, consistently formatted full duration, and a friendly container/codec/dimensions summary while hiding raw technical identifiers from the default view. Provide a compact current-video/change-video flow for narrow screens.

**Blocked by:** 01

**Category:** enhancement
**Status:** complete

- [x] Media entries show filename, duration, readable container, codec, and dimensions.
- [x] Raw aliases, language codes, dispositions, stream indexes, and internal IDs are absent from the default list.
- [x] Selected media is exposed semantically and long content cannot force horizontal overflow.
- [x] Narrow layouts can collapse the explorer after selection and expose a "Change video" action.

## Comments

- 2026-09-03: Integrated media explorer commit 154b25e; handoff reported focused tests, lint, build, and formatting passed. Integration rerun was unavailable because client dependencies are not installed; diff checks passed.
