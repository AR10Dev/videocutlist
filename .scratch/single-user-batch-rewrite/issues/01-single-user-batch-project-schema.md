# 01: Introduce the single-user batch project schema

**What to build:** A breaking versioned persistence and domain contract where one project contains an ordered collection of independent media-edit items and no persisted ownership data.

**Blocked by:** None

**Category:** enhancement
**Status:** ready-for-agent

- [ ] A project document contains a non-empty name and ordered items with stable opaque item IDs, media IDs, segments, optional editor state, and export options.
- [ ] The same media ID may appear in more than one project item.
- [ ] Revision belongs to the project envelope rather than being duplicated inside the editable document.
- [ ] Project and job schemas contain no owner, principal, role, or capability columns.
- [ ] Existing single-media projects migrate to one-item batch projects without losing segments or editor state.
- [ ] Existing media records remain usable after migration.
- [ ] The schema contract and migration tests cover upgrade from the current database.
- [ ] No project response contains an original-media or destination filesystem path.

## Comments
