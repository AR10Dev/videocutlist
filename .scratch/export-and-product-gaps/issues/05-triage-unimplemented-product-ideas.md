# 05: Triage unimplemented product ideas

**What to build:** A product-scope decision for each unimplemented idea retained from the LosslessCut research.

**Blocked by:** None (can start immediately)

**Category:** enhancement
**Status:** wontfix

## Candidates

- Persistent standalone markers and project autosave
- Timeline keyframe visualization and actual output-boundary reporting
- Output-container choice and compatibility guidance beyond MKV
- Additional interchange formats and a CLI
- Expression-based batch operations
- Scene-change detection and other optional automation

## Triage outcome

- [x] Each candidate is accepted into its own agent-ready ticket or rejected with a short reason.
- [x] Accepted work has explicit behavior, acceptance criteria, blockers, and scope boundaries.
- [x] Rejected enhancements are recorded through the triage out-of-scope workflow.

## Human triage outcome

- Rejected: standalone markers and autosave — the current segment-first project workflow is sufficient.
- Rejected: timeline keyframe marks and actual-boundary reporting — keep the existing warnings until a concrete UX requirement exists.
- Rejected: output-container choice — MKV-only avoids untested compatibility claims.
- Rejected: extra interchange formats and a CLI — CSV and chapters cover the supported workflow.
- Rejected: expression batches — unnecessary scripting surface and safety scope.
- Rejected: scene-change and other automation — no approved user need; avoid false-positive handling scope.

## Comments

- Human triage kept the implemented lossless-first workflow and rejected all optional research ideas as out of scope. Reopen with a user-facing requirement and acceptance criteria.
