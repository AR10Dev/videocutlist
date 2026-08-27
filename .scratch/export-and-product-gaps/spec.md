# Export validation and product gaps

**Status:** ready-for-agent

## Problem Statement

The trusted export workflow is implemented, but important strategy, stream, download, and browser behavior lacks coverage. The former roadmap and product research also mixed committed validation work with optional feature ideas.

## Solution

Add end-to-end evidence for the implemented export contract. Keep unapproved product ideas in a separate triage ticket so agents do not mistake research for scope.

## User Stories

1. As a user, I want each cut strategy verified against representative media so that export warnings and results are trustworthy.
2. As a user with complex media, I want stream selection and output verification tested so that unsupported or corrupt outputs fail safely.
3. As a user downloading an export, I want authorization and lifecycle boundaries tested so that another user or crafted request cannot access it.
4. As a user reviewing an export in the browser, I want preflight, blockers, status, warnings, and download availability to remain coherent.

## Implementation Decisions

- Exercise keyframe-aligned and sparse-keyframe media across stream-copy, precise re-encode, and hybrid smart-cut strategies.
- Exercise video-only, multi-audio, subtitle, attachment/data, and corrupt-output cases.
- Verify selected stream identity, forbidden streams, plausible duration, and parseable output.
- Verify download ownership, position validation, traversal resistance, expiry, cancellation, durable destinations, and response headers.
- Original-media and internal filesystem paths remain absent from every response.

## Testing Decisions

- Assert externally observable strategy, warning, stream, lifecycle, and browser behavior.
- Keep generated media in integration tests and fake probe results in fast verifier tests.
- Extend existing export, API, and browser seams rather than adding new harnesses.
- After tickets 01–04, run `make test`, `make check`, and `make smoke`.

## Out of Scope

- Changing the implemented export workflow while adding coverage
- Treating optional LosslessCut ideas as approved features
- Transitions, overlays, resize/crop effects, color grading, audio mixing, or burned subtitles

## Further Notes

The former root `ROADMAP.md` and `research.md` were migrated here. See `research.md` for source findings and issue 05 for unimplemented ideas awaiting triage.
