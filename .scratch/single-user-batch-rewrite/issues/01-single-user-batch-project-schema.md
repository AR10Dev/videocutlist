# 01: Introduce the single-user batch project schema

**What to build:** A breaking versioned persistence and domain contract where one project contains an ordered collection of independent media-edit items and no persisted ownership data.

**Blocked by:** None

**Category:** enhancement
**Status:** completed

- [x] A project document contains a non-empty name and ordered items with stable opaque item IDs, media IDs, segments, optional editor state, and export options.
- [x] The same media ID may appear in more than one project item.
- [x] Revision belongs to the project envelope rather than being duplicated inside the editable document.
- [x] Project and job schemas contain no owner, principal, role, or capability columns.
- [x] Existing single-media projects migrate to one-item batch projects without losing segments or editor state.
- [x] Existing media records remain usable after migration.
- [x] The schema contract and migration tests cover upgrade from the current database.
- [x] No project response contains an original-media or destination filesystem path.

## Comments

- Implemented the version-2 batch document (`name`, ordered opaque-ID items, per-item segments/editor state/export options) and deterministic legacy item IDs.
- Migrated existing SQLite project documents to one-item batches while preserving project revision, segments, editor state, and media rows; rebuilt project/export/detection tables without persisted ownership columns.
- Transitional store method ownership parameters remain accepted but are ignored until tickets 02/03 remove those APIs. `make check` passed.
