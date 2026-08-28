# 14: Preserve legacy project flows during the batch schema cutover

**What to build:** A safe compatibility boundary so existing project creation, export, detection, and interchange flows produce and consume valid one-item batch documents until ticket 02 replaces those paths.

**Blocked by:** None

**Category:** bug
**Status:** needs-validation

- [ ] Existing legacy project-save requests are converted to a valid version-2 document with a non-empty name and one ordered item.
- [ ] Existing export, detection, and interchange flows resolve a valid selected project item rather than reading removed legacy document fields.
- [ ] Multi-item projects are rejected by legacy single-item operations with a stable error rather than silently using an empty media ID.
- [ ] Regression tests cover creating, saving, exporting, detecting, and interchanging a migrated single-item project.

## Comments

- Opened from the post-merge review of ticket 01. `protocol/http/api.go` still constructs a legacy-only `Document`, which serializes as an invalid version-2 document; export, detection, and interchange also read removed `Document.MediaID` and `Document.Segments` fields. This is a deployability blocker until the compatibility conversion or ticket-02 replacement lands.
- Implemented the one-item compatibility conversion and explicit multi-item rejection. Validation could not be rerun because `/tmp` is full; rerun `go test ./...`, `go vet ./...`, and `make check` once temporary space is available.
