# 04: Browse a safe media folder tree

**What to build:** Users can expand and collapse the configured library's safe virtual folders and select indexed video items from the tree.

**Blocked by:** 01, 02

**Category:** enhancement
**Status:** needs-triage

- [ ] Folder nodes use stable opaque IDs and display labels approved by the security review.
- [ ] Selecting a video continues to use its existing opaque media ID.
- [ ] The browser never receives an original-media filesystem path.
- [ ] The tree handles an empty folder and pagination without pretending all media is loaded.

## Comments

Needs a decision on whether directory names are acceptable display metadata.
