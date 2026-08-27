# 06: Build the media-library settings screen

**What to build:** Add an administrator Library settings section for managing named server media directories and rescanning them.

**Blocked by:** 04, 05

**Category:** enhancement
**Status:** proposed

- [ ] The screen lists each root’s alias, administrator-visible configured path, health, last scan state, and media count where available.
- [ ] An administrator can add, rename, change, and remove roots in a draft; Save submits one atomic update and reports field-level validation errors.
- [ ] The UI accepts typed absolute paths; it does not pretend a browser file picker can choose a server filesystem directory.
- [ ] Native-path guidance explains that the service account needs read access. Container-path guidance explains that host directories must first be mounted and only the container path is entered.
- [ ] Save and Rescan have clear pending/success/failure states and do not duplicate concurrent operations.
- [ ] The screen never renders configured source paths for a caller without settings-management authorization.
- [ ] Playwright coverage manages multiple roots, handles rejected paths, verifies a rescan, and confirms that configured paths do not appear in the normal File explorer.

## Comments

Media is read-only by design. Root aliases are useful user-facing labels and also participate in opaque media identity, so alias changes need an explicit warning that prior project media IDs will no longer resolve.
