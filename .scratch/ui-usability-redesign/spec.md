# Editing workspace usability redesign

**Status:** complete

## Problem

The editing workspace exposes media selection, timeline editing, project administration, interchange, export configuration, and detection at the same time. The result is a long, dense page with no clear next action.

The timeline also presents conflicting time information. A selected video may show a duration of `00:52.209` while the generated preview player shows about eight seconds. The native preview scrubber and the full-video timeline look like two controls for the same range.

At 1024 by 768, the current page grows to about 2,284 pixels tall. At 390 by 844, it grows to about 3,084 pixels. Primary actions move far below the fold, media metadata overflows, and narrow layouts require too much scrolling.

## Outcome

A user can select a video, mark and review segments, save the project, run detection, and export without having to understand internal IDs, stream metadata, or preview generation.

The workspace presents one active task at a time. Timeline controls remain central. Project, export, and detection controls share a compact task panel instead of forming one long sidebar.

## Product decisions

- Keep the existing dark theme and plain CSS stack.
- Keep the media explorer, editor, and task panel as the three main workspace areas on wide screens.
- Present Project, Export, and Detection as tabs or an equivalent single-open-section control in the task panel.
- Selecting media opens an unsaved draft. The UI calls it an "Unsaved project" and does not expose its generated ID in the main workflow.
- The full-video timeline is the only prominent seek control.
- The generated preview is identified as a short window around the absolute playhead. Its controls do not present a second prominent seek bar.
- Advanced export and technical media details stay collapsed by default.
- Status and error messages appear beside the action or control they describe, not in the global header.
- No new UI framework or component dependency is introduced.

## Workspace structure

### Header

The header contains:

- Product name
- Current project name or "Unsaved project"
- Save state, using short text such as "Saved" or "Unsaved"
- Settings action

Remove transient messages such as "Preview ready" from the header.

### Media explorer

Each media entry shows:

- Filename
- Consistently formatted duration
- Friendly summary such as `MP4 · H.264 · 854×480`

Raw container aliases, language codes, dispositions, and stream indexes are hidden from the list. They may appear in an optional details view.

The selected item remains visually distinct. Long names and metadata wrap or truncate without creating a horizontal scrollbar.

On narrow screens, the explorer collapses after selection into a compact current-video control with a "Change video" action.

### Editor

The editor shows:

1. Video name and full duration
2. Absolute playhead time and segment status
3. Preview player
4. Full-video filmstrip and timeline
5. Marker controls
6. Segment list

The preview identifies its range, for example:

```text
Preview: 00:28.000 to 00:36.000
Playhead: 00:32.339 of 00:52.209
```

The filmstrip must render readable thumbnails without large unexplained black bands. It includes enough time labels to make position and scale clear.

Marker controls follow the editing sequence:

1. Set start
2. Set end
3. Add segment

"Add segment" remains disabled until the marker range is valid. The UI states why when it is disabled. Previous frame, next frame, undo, and redo remain available but have lower visual priority.

The segment list shows each saved range, its optional label, duration, and remove action. Selecting a segment highlights its range on the timeline.

### Task panel

Only one of the following sections is open at a time.

#### Project

The default view contains:

- Project name
- Save project
- New project
- Load project
- Ordered media items

Project ID and revision move into collapsed project details. Disabled move controls do not occupy prominent space when the project has one item.

Cut-list import, cut-list download, CSV export, and chapter export move into one "Interchange" menu or subsection. Replace repeated save warnings with one message and one direct save action.

Removing a media item uses destructive styling and requires confirmation when the item has edits.

#### Export

The default view contains:

- What will be exported
- Selection, such as segments or gaps
- Destination
- Output name preview
- Primary Export action

Mode, stream selection, cut strategy, and filename template move under "Advanced options".

Technical values use readable labels. For example, show `Video: H.264, 854×480` instead of `videoh264 · und · default (#0)`.

When export is unavailable, show the exact blocker beside the primary action. Examples include:

- Add at least one segment.
- Save the project before exporting.
- Select at least one project item.
- The source video is unavailable.

Do not use the generic message "Export preflight failed" as the only explanation.

#### Detection

The section contains the available detection methods and a short description of what each method adds. Results remain reviewable before they change the segment list.

Detection progress and errors appear inside this section. Starting detection does not push the user to a separate part of the page.

## Visual hierarchy

- Use one primary action per open section.
- Use neutral styling for secondary actions.
- Reserve destructive styling for removal and irreversible actions.
- Do not use the same amber treatment for selection, markers, and unrelated primary actions.
- Reduce borders where spacing and headings already separate content.
- Use sentence case for section headings.
- Keep help text short and place longer explanations behind disclosure controls.
- Format all durations as `HH:MM:SS.mmm` when hours are present and `MM:SS.mmm` otherwise.

## Responsive behavior

### Wide screens

At 1440 by 900:

- Media explorer, editor, and task panel may appear side by side.
- The selected task's primary action remains visible without scrolling the whole document.
- The editor receives most of the width.

### Tablet

At 1024 by 768:

- The editor remains the primary area.
- The media explorer becomes narrower or collapsible.
- The task panel appears as tabs below the editor or as a dismissible side panel.
- No panel creates a horizontal scrollbar.

### Mobile

At 390 by 844:

- Use one column.
- Show the compact current-video control before the editor.
- Keep the timeline and marker controls before project, export, and detection tasks.
- Avoid large empty areas inside the media explorer.
- Touch targets are at least 44 by 44 CSS pixels.

## Accessibility

- All controls are reachable and operable by keyboard.
- Focus remains visible against the dark background.
- Frame stepping, playback, marker placement, undo, and redo expose documented keyboard shortcuts.
- Text and interactive controls meet WCAG 2.1 AA contrast requirements.
- Disabled actions expose their reason in visible text and to assistive technology.
- Tabs, disclosure controls, timeline sliders, markers, and selected media expose their state through semantic HTML and accessible names.
- Status updates use an appropriate live region without repeatedly interrupting screen-reader users.

## Acceptance criteria

- [x] The workspace exposes one open task section at a time for Project, Export, or Detection.
- [x] The global header contains no preview or operation status message.
- [x] The preview labels its absolute source range and does not look like a second full-video timeline.
- [x] The selected video's duration and absolute playhead use consistent formatting everywhere.
- [x] A user can set a start marker, set an end marker, and add a segment in the displayed control order.
- [x] "Add segment" cannot submit an invalid or empty range and states why it is unavailable.
- [x] Added segments appear in a visible segment list and can be selected and removed.
- [x] Export presents one primary action and names every blocking condition next to it.
- [x] Advanced export controls start collapsed.
- [x] Project ID, revision, raw container aliases, language codes, dispositions, and stream indexes do not appear in the default workspace view.
- [x] Repeated project-save warnings are replaced by one actionable message.
- [x] Media cards and task controls create no horizontal scrollbar at 1024 by 768 or 390 by 844.
- [x] The page does not require scrolling past closed Project, Export, or Detection content to reach the active task's primary action.
- [x] Media entries expose filename, duration, container, codec, and dimensions using readable labels.
- [x] The filmstrip contains readable thumbnails and visible time references.
- [x] Keyboard-only users can select media, edit markers, manage segments, save, run detection, and start a valid export.
- [x] Automated browser tests cover 1440×900, 1024×768, and 390×844 layouts.
- [x] Web lint, Vitest, build, and Playwright checks pass.

## Out of scope

- Changes to media indexing, preview generation, detection algorithms, or export processing
- Changes to HTTP or database contracts unless required to expose an existing actionable error
- A new theme or visual brand
- Drag-and-drop timeline editing
- Multi-track editing, transitions, compositing, or audio mixing
- A new frontend framework, design system, or component dependency
