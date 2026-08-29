# 62: Complete OpenAPI response schemas

**What to build:** Add the missing contractual API schemas to OpenAPI, regenerate browser types, replace the remaining handwritten App response models, and remove obsolete tracking evidence.

**Blocked by:** 61

**Category:** bug
**Status:** completed

- [x] OpenAPI defines contract schemas for folder pages, runtime settings, and detection jobs where those endpoints return them.
- [x] Generated browser types are regenerated from the checked-in contract.
- [x] App aliases folder, runtime-settings, and detection-job responses to generated schemas; no contract-backed handwritten duplicates remain.
- [x] Ticket 50 removes its obsolete pre-ticket-49 incompatibility comment and accurately records completion.
- [x] `make check` and the full interchange Playwright file pass.

## Comments

Opened from tickets 49–61 final review. Added folder, runtime-settings, and detection schemas to the checked-in OpenAPI contract, regenerated browser types, and replaced the corresponding App response aliases. Validation: `make check` passes.
