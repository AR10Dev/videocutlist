# Solid 2 migration plan

## Goal

Replace the React client runtime with Solid 2 while preserving VideoCutList behavior, API contracts, accessibility, cancellation, and plain-CSS styling. No compatibility layer, routing framework, Tailwind, or component library will be added.

## Invariants

- Go APIs, opaque media IDs, preview MSE streaming, and server-side delivery stay unchanged.
- A migration milestone must leave the React client buildable until the final atomic runtime switch.
- Request-version guards, abort controllers, timers, object-URL revocation, and unload protection remain explicit.
- The final client has no `react`, `react-dom`, React Vite plugin, React ESLint plugin, or React imports.

## Milestone 1: Stabilize component seams

1. Format the extracted React component sources as readable source, not generated one-line code.
2. Verify `MediaBrowser`, `TimelineEditor`, `ProjectJobs`, `StatusHeader`, `PreviewDiagnostics`, and `TimelineCanvas` preserve their current props and behavior.
3. Run client lint, tests, build, and Playwright.

**Gate:** current React client is behaviorally intact and all checks pass.

## Milestone 2: Introduce a framework-neutral controller boundary

1. Move App orchestration types and pure helpers into focused client modules.
2. Keep asynchronous workflows explicit: media load/refresh, preview lifecycle, project load/save, assets, export, and detection.
3. Preserve the React adapter during this milestone; do not alter runtime dependencies.

**Gate:** React App is a thin adapter around named controller operations, with no behavior change.

## Milestone 3: Convert the controller to Solid state

1. Replace the editor reducer with `createStore`.
2. Replace independent UI state with named signals.
3. Replace DOM/request refs with local mutable handles.
4. Convert effects individually to Solid 2 `createEffect` and `onSettled`, preserving cleanup returns.
5. Keep request-version and cancellation checks unchanged.

**Gate:** TypeScript and focused behavior checks pass in a Solid-only client branch before JSX/runtime conversion.

## Milestone 4: Convert presentation components

1. Convert leaf components first: status, diagnostics, media browser, canvas.
2. Convert timeline editor and project/jobs components after their state contracts are settled.
3. Use Solid control flow and event conventions; preserve IDs, ARIA, labels, disabled states, and CSS classes.
4. Keep canvas rendering and `ResizeObserver` lifecycle behavior.

**Gate:** no component imports React and component props use Solid types only.

## Milestone 5: Atomic runtime switch

1. Change `main.tsx` to `@solidjs/web` `render`.
2. Replace dependencies and Vite plugin with the coordinated Solid 2 RC packages.
3. Set TypeScript JSX configuration for `@solidjs/web`.
4. Remove React ESLint configuration and all React packages; regenerate the lockfile.

**Gate:** no React references remain in source, package manifest, or lockfile.

## Milestone 6: Verification and review

1. Run client lint, Vitest, production build, and Playwright.
2. Run `make check` and `make smoke`.
3. Compare rendered user flows: media selection, preview cancellation, timeline edits/history, projects/interchange, export, detection, and diagnostics.
4. Run a fresh-context correctness and simplicity review; repair accepted findings.

## Rollback

Do not keep a mixed runtime. If a final-switch gate fails, restore the last validated React milestone, fix the named conversion issue, and retry the atomic switch.
