# 11: Update folder-browser Playwright fixtures

**What to build:** Browser tests exercise the safe folder-tree API used by the application and remain green after the folder-browser repair.

**Blocked by:** 04

**Category:** bug
**Status:** ready-for-agent

- [ ] Shared media fixtures mock `/api/v1/media/tree` with the root folder page expected by first-load and refresh flows.
- [ ] Segment-selection tests can select fixture media before testing preview, detection, and timeline behavior.
- [ ] `pnpm --dir client run test:e2e` passes.

## Comments

Opened during final validation of tickets 02, 04, 08, 09, and 10. The Playwright suite times out waiting for `camera.mp4` because its fixtures still support the old flat media request path while the repaired client loads the folder-tree endpoint.
