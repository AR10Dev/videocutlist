# 09: Reconcile media-library status UI with first-run setup

**What to build:** Integrate the distinct loading, scanning, empty, unconfigured, and failed library states into the first-run workspace without duplicating or conflicting with tickets 03 and 06.

**Blocked by:** 03, 06

**Category:** bug
**Status:** ready-for-agent

- [ ] Each status has one visible, actionable message.
- [ ] The status response is fetched and refreshed without duplicate requests or stale messages.
- [ ] Browser tests cover every state and the pre-media workflow.

## Comments

The independent ticket 05 implementation conflicted with the merged first-run and workflow-gating changes. Reimplement its behavior against the integrated workspace rather than attempting another patch merge.
