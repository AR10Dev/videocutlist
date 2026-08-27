# 02: Import media through a bounded server-side job

**What to build:** A user can add a permitted file or folder to the media library through a server-side import job that reports progress and item-level results without sending original filesystem paths to the browser.

**Blocked by:** None

**Category:** enhancement
**Status:** complete

- [x] The product contract defines imports from configured allowlisted server roots only.
- [x] Folder imports resolve beneath server roots, enforce recursion and file-count limits, and support cancellation.
- [x] The API returns opaque job/media IDs, safe metadata, progress, and validation failures without source paths.

## Comments

LosslessCut can use native folder access because it is a desktop app. VideoCutlist cannot expose that model directly in its browser API.
