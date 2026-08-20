# Solid 2 feature-port plan

## Strategy

Build a new Solid 2 client from the React client’s observable behavior rather than converting React hooks. Breaking internal frontend changes are allowed. The Go HTTP contract, opaque media IDs, and media security constraints remain fixed.

The existing React implementation is the comparison oracle until the Solid client is complete.

## Feature inventory

1. Configuration and authenticated API client.
2. Media list, pagination, refresh, selection, and metadata.
3. Timeline: playhead, in/out, segments, zoom, undo/redo, markers, timecode, frame stepping, canvas assets.
4. Native video/MSE preview, cancellation, diagnostics, mute state, and preview failure states.
5. Project create/load/save, revision handling, recent projects, discard protection, JSON/CSV/chapters interchange.
6. Export request, options, stream selection, status polling, cancellation, results/errors.
7. Detection request, candidates, polling, acceptance/rejection, cancellation/errors.
8. Accessibility: existing IDs, labels, live status, keyboard-native controls, and diagnostic text.

## Milestones

### A. Behavioral map

Document each React UI flow, its API calls, state transition, and test coverage. Identify gaps and add behavior-level tests only where a port would otherwise be ambiguous.

**Gate:** every listed feature has a defined Solid acceptance flow.

### B. New Solid foundation

Replace the client runtime/tooling with Solid 2 RC, then create a new Solid root, typed state model, and API/controller modules. Do not retain React or a compatibility layer.

**Gate:** Solid build renders the shell and API configuration errors safely.

### C. Editor core

Port media selection, state/history, timeline, assets, and preview. Use native video and canvas. Keep cancellation, request versions, URL cleanup, and timers explicit.

**Gate:** media/timeline/preview flows match the React reference.

### D. Persistence and jobs

Port projects/interchange, then export and detection workflows.

**Gate:** project, export, and detection flows match the reference.

### E. Comparison and cutover

Run the React-derived Vitest/Playwright flows against Solid; manually compare behavior where no browser test exists. Remove React artifacts only after the acceptance matrix passes.

## Verification

- `pnpm --dir client run lint`
- `pnpm --dir client test`
- `pnpm --dir client run build`
- `pnpm --dir client run test:e2e`
- `make check`
- `make smoke`

Each port milestone reports feature flows completed, changed files, command output, and remaining differences.
