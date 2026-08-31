# 63: Remove remaining generated contract duplicates

**What to build:** Replace the remaining handwritten export preflight and detection candidate response models with generated OpenAPI schemas, without changing UI behavior.

**Blocked by:** 62

**Category:** bug
**Status:** completed

- [x] App uses generated `ExportPreflight` rather than a handwritten response type.
- [x] Detection candidate and kind types are derived from generated schemas where the contract defines them.
- [x] No contract-backed handwritten response duplicates remain in App or detection modules.
- [x] `make check` and the full interchange Playwright file pass.

## Comments

Opened from the final review of tickets 49–62. Replaced the remaining preflight and detection candidate/kind duplicates with generated OpenAPI schema aliases. Validation: client tests, production build, Oxlint, and `make check` pass.
