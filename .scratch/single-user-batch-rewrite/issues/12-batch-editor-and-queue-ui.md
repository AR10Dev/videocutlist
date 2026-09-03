# 12: Build the batch editor and queue UI

**What to build:** A feature-oriented browser interface for editing ordered independent media items and monitoring durable batches while editing continues.

**Blocked by:** 05, 08, 11

**Category:** enhancement
**Status:** completed

- [x] A project can add, remove, select, and reorder media items with an explicit unsaved-change guard.
- [x] Each item keeps independent segments, playhead, zoom, undo, and redo state.
- [x] The user can submit all or selected items for export and sees the immutable project revision used by the batch.
- [x] Queue views show child kind, media label, state, progress, warning, result, and failure code without paths.
- [x] The user can cancel a batch or child job and explicitly retry a failed child as a new job.
- [x] Project editing and saving remain available while background jobs run.
- [x] Reloading the browser restores persisted project and queue state from the server.
- [x] `App.tsx` composes feature views; library, editor, preview, export, detection, queue, and settings logic live in their feature modules.
- [x] Accessible controls and Playwright tests cover multi-item editing, queued execution, cancellation, restart-visible state, and continued editing.

## Comments

- `App.tsx` now composes typed feature views directly. Shared cross-feature coordination is isolated in `features/app/controller.ts`; media, settings, editor, preview, export, detection, projects, and queue own their state, lifecycle, views, or domain helpers.
