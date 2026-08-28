# 24: Inject and test the batch export HTTP service

**What to build:** Complete server injection and end-to-end HTTP coverage for the batch export service, including the source-change sentinel.

**Blocked by:** 23

**Category:** bug
**Status:** completed

- [x] Server configuration injects the constructed batch export service into the HTTP API.
- [x] Missing media wraps `store.ErrSourceChanged` and persists child failure code `source_changed`.
- [x] HTTP regression tests exercise batch submission, progress retrieval, and cancellation through the injected batch service.

## Comments

- Opened from post-merge review of ticket 23. The HTTP config omits the already-created batch export service, so all new endpoints fall back or fail; missing media still returns a raw source-change error; no HTTP test proves the new dependency is used.
- Injected the production batch export service, wrapped unavailable sources with `store.ErrSourceChanged`, and added HTTP lifecycle coverage plus missing-source sentinel assertions. `make check` passed.
