# 29: Atomically apply root settings and prove catalog identity

**What to build:** Keep persisted/runtime root settings synchronized with scanner and catalog state when reconfiguration fails, and prove cancellation preserves the original record.

**Blocked by:** 28

**Category:** bug
**Status:** ready-for-agent

- [ ] A failed runtime root reconfiguration leaves persisted settings, runtime configuration, scanner roots, and catalog records at their prior values.
- [ ] A successful root change commits settings only after runtime application succeeds.
- [ ] Refresh cancellation regression retrieves the originally indexed opaque media ID after cancellation.

## Comments

- Opened from post-merge review of ticket 28. Scanner/store reconfiguration is atomic, but `putSettings` persists settings and runtime configuration before `Scanner.Reconfigure`; a failed root removal leaves those layers inconsistent. The cancellation regression still checks only record count.
