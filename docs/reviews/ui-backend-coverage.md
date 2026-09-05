# UI review and backend coverage

## Scope and result

Reviewed all five supplied screenshots, traced the HTTP routes and their client callers, changed the UI, and tested the resulting workbench. All identified user-facing capability gaps are now represented in the client. This is a capability audit, not a guarantee that every browser, codec, deployment, and failure combination has been tested.

The work is uncommitted. Base commit: `72fa49e7fc5bcfa2a4232d23e3d137dbd221cd3c`.

## Screenshot-by-screenshot findings

| Screenshot | Problems | Changes |
| --- | --- | --- |
| Detection | Oversized/duplicated Media area; cramped tabs; unexplained detection actions; clipped timeline | Removed the invalid drawer layout; balanced tabs; compact library rows; added detection guidance and optional silence/minimum-duration/scene sensitivity controls; kept scan cancellation and review/accept/dismiss actions |
| Export | Stretched checkboxes; unresolved `{source}` filename; misleading output count with no cuts; disabled export gives no nearby way to save | Correct checkbox components and sizing; actual per-item output/range totals including gaps; readable filename estimate; Save project action and save-error feedback in Export; authenticated downloads available for every completed queue item |
| Project | Excessive vertical whitespace; awkward menu-based reorder buttons; Load requires an opaque ID; no server project browser | Normal list layout; server-backed project browser with pagination, accessible even before media selection; retained explicit Load by ID and local Recent projects; repaired multi-item JSON cut-list round-trip |
| Cuts | Bright oversized empty-state alert; guidance effectively hidden; controls wrap unpredictably; timeline below viewport | Quiet actionable empty state; visible range guidance and validation; visible label/reorder/split/remove/jump controls; removed Duplicate because overlapping duplicate segments cannot be saved by the backend; responsive transport and fit timeline |
| Settings | Checkbox styled as full-width text input; overflowing layout; empty Media sidebar; long page without a clear return action | Proper checkbox; bounded independently scrolling settings; no empty Media sidebar; explicit Back to editor; server/destination fields disabled during saves to avoid silently losing concurrent edits |

Shared root causes included a color named `--border` colliding with daisyUI's border-width token, unlayered generic overrides, incomplete responsive grid areas, and using `drawer`/`menu` component classes without their required structure. The stylesheet now separates base rules, component appearance, and workbench layout. Sidebars remain resizable on desktop; narrow layouts use document scrolling.

The black preview also had a behavioral cause: Settings unmounted the player but the controller kept a non-reactive reference to the old video element. The reference is now reactive, cleaned up on unmount, and reattached at the current position on return. Playback/fullscreen errors are reported and unavailable controls are disabled. Timecodes accept hours and resume tracking playback after a manual seek.

## Backend capability coverage

Paths below are relative to `/api/v1` unless noted. Method aliases and operational endpoints do not require duplicate UI buttons.

| Backend surface | UI entry point / coverage |
| --- | --- |
| `GET media/tree`, `GET media/status` | Media folders, status, All media, cursor pagination |
| `GET media` | Equivalent flat listing covered by the tree's All media view; no redundant second browser |
| `POST media/refresh`, `POST media/import` | Refresh starts the same backend import/scan service |
| `GET media/import/{id}`, `DELETE media/import/{id}` | Scan progress, indexed count, errors, and Cancel scan |
| `GET media/{id}` | Selecting/restoring project media and metadata |
| `GET/HEAD media/{id}/preview` | Preview playback, seeking, frame/cut navigation, audio controls; GET supplies preview content |
| `GET media/{id}/thumbnails`, `GET media/{id}/waveform` | Independent timeline thumbnail/waveform lanes with failure guidance |
| `GET projects` | Browse saved projects, refresh, pagination |
| `GET projects/{id}`, `PUT projects/{id}` | Load, Save, revision-conflict reporting, recent-project restore; independent multi-item edits and ordering |
| `GET/POST projects/{id}/interchange/csv` | CSV import/export |
| `GET/POST projects/{id}/interchange/chapters` | Chapter import/export |
| Client JSON interchange | Download/import multi-item cut lists as new unsaved projects; legacy single-media import retained; media IDs and runtime-relevant fields validated before use |
| `POST projects/{id}/exports/preflight` | Export findings and single-item eligibility checks; server remains authoritative for submission validation |
| `POST projects/{id}/exports` | Selected project items; per-item arrangement, cuts/gaps, streams, strategy, destination and filename options; MKV is the backend's supported output container |
| `GET batches`, `GET batches/{id}` | Persistent export queue, progress, job details, warnings and output names |
| `DELETE batches/{id}` | Cancel batch |
| `GET jobs/{id}`, `DELETE jobs/{id}` | Export/detection polling and cancellation |
| `POST jobs/{id}/retry` | Retry failed export child as a new job |
| `GET jobs/{id}/outputs/{position}` | Authenticated downloads in current export and historical queue; all output positions surfaced |
| `POST projects/{id}/detections` | Silence, black-frame and scene detection; optional noise/minimum-duration/scene thresholds; candidates reviewed before acceptance |
| `GET destinations` | Destination selection and retention display |
| `GET/PUT settings` | Administrator settings, safe root aliases, destination metadata, export/preview concurrency, preview windows/grid, scan limits and disposable cache size |
| `POST settings/media/refresh` | Administrator Rescan library; normal Media Refresh supplies the tracked scan/cancel workflow |
| `GET health`, `GET ready`, `/metrics` | Operational probe/monitoring endpoints, intentionally not editing buttons |
| `POST automation` | External loopback-only automation; intentionally not exposed to browser JavaScript because the backend rejects browser origins |

No backend routes or security contracts were changed. Original-media paths remain server-side. Browser operations use opaque IDs. Hardware encoder enablement and deployment-managed roots were not converted into unsafe browser settings.

## Validation

- `make smoke`: **passed**, including `make check` and `make test`.
- Go formatting check, vet, race tests, embedded-frontend tests/vet and build: **passed**.
- Client lint, TypeScript and production build: **passed**.
- Vitest: **98 passed** across 20 files.
- Playwright/Chromium: **76 passed**.
- `pnpm --dir client run format:check`: **passed**.
- `git diff --check`: **passed**.
- Primary TypeScript diagnostics: **clean**.
- Geometry regressions cover 390, 700, 1050, 1051, 1280 and 1717px, including bounded checkboxes, first-row navbar, nonoverlapping tabs, timeline visibility and local zoom overflow.
- New functional checks cover server-project browsing/pagination, import scan progress/cancel, detection parameter validation, bearer-authenticated queue downloads, settings save interlocks, visible cut editing, multi-item JSON import, player remounting after Settings, timecode tracking and imported-data validation.

### Live-media checks

Used the running backend and its existing trailer through a temporary loopback-only development proxy. Reviewed fresh screenshots of Cuts, Project, Export, Detection and Settings. Verified seeking/playback, project save, a successful verified MKV export, and retrieval/FFprobe of that output. The stream-copy example requested 5–8 seconds and produced an 8.25-second file; the UI correctly displayed the non-frame-exact/keyframe warning. This is not evidence for frame-exact stream copy.

Returning from Settings was verified against a real video element (`readyState: 4`) after the remount fix. The saved test project is named **UI review smoke test**; its generated export uses the existing download retention policy. No originals were modified.

The agent-browser download command timed out for the JavaScript-triggered live download; output retrieval was verified directly against the output endpoint instead. The actual browser download click and bearer header are covered by Playwright. Do not misrepresent this as a successful live agent-browser download.

Temporary screenshots/logs/output are under `/tmp/vcl-*`; they are not committed artifacts. Initial parallel UI/backend audits completed. A final independent reviewer process failed to launch because of a harness module-resolution error; the final diff was reviewed directly, not independently approved.

## Changed files

- Shell/layout: `client/src/App.tsx`, `client/src/style.css`.
- Composition: `client/src/features/app/controller.ts`.
- Editor: `CutsView.tsx`, `EditorView.tsx`, `controller.ts` under `client/src/features/editor/`.
- Preview: `PreviewPlayer.tsx`, `controller.ts`, `model.ts` under `client/src/features/preview/`.
- Media: `LibraryView.tsx`, `controller.ts` under `client/src/features/media/`.
- Projects: `ProjectsView.tsx`, new `ProjectBrowser.tsx`, `controller.ts`, `lifecycle.ts` under `client/src/features/projects/`.
- Export/queue: `ExportView.tsx`, new `OutputDownload.tsx`, new `summary.ts` under `client/src/features/export/`; `client/src/features/queue/QueueView.tsx`.
- Detection: `DetectionView.tsx`, `controller.ts` under `client/src/features/detection/`.
- Settings: `client/src/features/settings/SettingsView.tsx`.
- Tests: `client/playwright/segment-selection.spec.ts`, new `client/playwright/polished-workspace.spec.ts`, new `client/tests/workspacePolish.test.ts`.
- Report: this file.

## Remaining limits and deployment

- Automated browser coverage is Chromium, not a certification of Safari/Firefox, all codecs, hardware encoders, or production authentication configurations.
- Authenticated downloads currently buffer one output as a Blob. Very large exports may require streamed file writes or a dedicated authorized-download design.
- Filename previews are estimates: the server sanitizes names and adds collision-safe suffixes.
- Server-side batch preflight/validation and deployment-managed limits remain authoritative. No browser automation button bypasses these boundaries.
- Rebuild/restart the deployed service or container to load the latest bundled frontend. The already-running service may retain its previously loaded asset snapshot; refreshing that old page alone is not proof of deployment. Build and test artifacts are ready, but no production process was restarted as part of this change.
- No commit was created. Base commit above is for review context, not a commit containing these changes.
