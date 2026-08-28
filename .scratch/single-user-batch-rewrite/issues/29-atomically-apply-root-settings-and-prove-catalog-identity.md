# 29: Atomically apply root settings and prove catalog identity

**What to build:** Keep persisted/runtime root settings synchronized with scanner and catalog state when reconfiguration fails, and prove cancellation preserves the original record.

**Blocked by:** 28

**Category:** bug
**Status:** completed

- [x] A failed runtime root reconfiguration leaves persisted settings, runtime configuration, scanner roots, and catalog records at their prior values.
- [x] A successful root change commits settings only after runtime application succeeds.
- [x] Refresh cancellation regression retrieves the originally indexed opaque media ID after cancellation.

## Comments

- Opened from post-merge review of ticket 28. Scanner/store reconfiguration is atomic, but `putSettings` persisted settings and runtime configuration before `Scanner.Reconfigure`; a failed root removal left those layers inconsistent. The cancellation regression also checked only record count.
- Serialized settings updates, validated the current revision before applying runtime changes, and rollback runtime state when persistence fails. Added opaque-record retrieval coverage after cancelled refresh. `make check` passed.
