# 64: Redact browser-facing settings paths

**What to build:** Remove original-media and destination filesystem paths from the OpenAPI/browser settings contract and UI, preserving only aliases, safe availability diagnostics, and configurable non-path runtime values.

**Blocked by:** None

**Category:** bug
**Status:** completed

- [x] Browser OpenAPI schemas do not expose media-root, destination-root, or destination-media-root filesystem paths.
- [x] Settings API responses and client UI expose aliases and safe availability diagnostics only.
- [x] Server-side deployment paths remain accepted and applied without being returned to the browser.
- [x] Tests prove browser settings payloads and rendered UI do not contain configured filesystem paths.
- [ ] Ticket 11 is updated with verified completion evidence after this fix.
- [x] `make check` and full interchange Playwright pass.

## Comments

Opened from final review of tickets 49–63. Redacted deployment paths from browser settings schemas and UI; server-side settings retain paths for runtime use. Validation: `make check` passes; backend redaction and generated-contract tests pass.
