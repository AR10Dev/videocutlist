# 02: Import media through a bounded server-side job

**What to build:** A user can add a permitted file or folder to the media library through a server-side import job that reports progress and item-level results without sending original filesystem paths to the browser.

**Blocked by:** None

**Category:** enhancement
**Status:** needs-triage

- [ ] The product contract defines whether imports come from a browser upload, a host-side picker, or an allowlisted server root.
- [ ] Folder imports resolve symlinks, remain beneath configured roots, have recursion and file-count limits, and support cancellation.
- [ ] The API returns opaque IDs, safe display metadata, progress, and validation failures without source paths.

## Comments

LosslessCut can use native folder access because it is a desktop app. VideoCutlist cannot expose that model directly in its browser API.
