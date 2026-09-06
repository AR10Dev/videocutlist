import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Settings, Undo2, Redo2 } from "lucide-solid";
import { DetectionView } from "./features/detection/DetectionView";
import { CutsView } from "./features/editor/CutsView";
import { EditorView } from "./features/editor/EditorView";
import { ExportView } from "./features/export/ExportView";
import { LibraryView } from "./features/media/LibraryView";
import { ProjectsView } from "./features/projects/ProjectsView";
import { QueueView } from "./features/queue/QueueView";
import { SettingsView } from "./features/settings/SettingsView";
import { createWorkspaceController } from "./features/app/controller";
import { WorkspaceProvider } from "./features/app/WorkspaceContext";
import { applyAppearance } from "./features/settings/model";
import {
  clampPanelPreferences,
  defaultPanelPreferences,
  PANEL_PREFERENCES_KEY,
  parsePanelPreferences,
  serializePanelPreferences,
} from "./features/app/panelPreferences";

export function App() {
  const controller = createWorkspaceController();
  const {
    selected,
    projectName,
    revision,
    dirty,
    saveState: projectSaveState,
    settingsOpen,
    setSettingsOpen,
    openSettings,
    appearance,
  } = controller;
  createEffect(() => {
    const preference = appearance();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(preference, media.matches);
    apply();
    if (preference === "system") media.addEventListener("change", apply);
    onCleanup(() => media.removeEventListener("change", apply));
  });
  const [activeTask, setActiveTask] = createSignal<"cuts" | "project" | "export" | "detection">(
    "project",
  );
  let hadSelectedMedia = false;
  let hadActiveItem = false;
  let previousSegmentCount = 0;
  createEffect(() => {
    const hasSelectedMedia = Boolean(selected());
    if (hasSelectedMedia && !hadSelectedMedia)
      queueMicrotask(() => {
        if (narrowViewport()) {
          closeMediaPanel(false);
          requestAnimationFrame(() => document.getElementById("timeline-heading")?.focus());
        }
        if (dirty() || !controller.activeItemId()) setActiveTask("cuts");
      });
    hadSelectedMedia = hasSelectedMedia;
  });
  createEffect(() => {
    const hasActiveItem = Boolean(controller.activeItemId());
    if (hasActiveItem && !hadActiveItem && narrowViewport())
      queueMicrotask(() => openTaskPanel("cuts", false));
    hadActiveItem = hasActiveItem;
  });
  createEffect(() => {
    const segmentCount = controller.present().segments.length;
    if (segmentCount > previousSegmentCount && narrowViewport() && !tasksOpen())
      queueMicrotask(() => openTaskPanel("cuts", false));
    previousSegmentCount = segmentCount;
  });
  const taskTabs = ["cuts", "project", "export", "detection"] as const;
  const initialPanelPreferences = (() => {
    const defaults = defaultPanelPreferences();
    try {
      const parsed = parsePanelPreferences(window.localStorage.getItem(PANEL_PREFERENCES_KEY));
      return window.innerWidth < 1050 ? parsed : clampPanelPreferences(parsed, window.innerWidth);
    } catch {
      return defaults;
    }
  })();
  const initialNarrowViewport = window.innerWidth < 1050;
  const [narrowViewport, setNarrowViewport] = createSignal(initialNarrowViewport);
  const [mediaWidth, setMediaWidth] = createSignal(initialPanelPreferences.mediaWidth);
  const [segmentsWidth, setSegmentsWidth] = createSignal(initialPanelPreferences.segmentsWidth);
  const [mediaCollapsed, setMediaCollapsed] = createSignal(initialPanelPreferences.mediaCollapsed);
  const [segmentsCollapsed, setSegmentsCollapsed] = createSignal(
    initialPanelPreferences.segmentsCollapsed,
  );
  const [mediaOpen, setMediaOpen] = createSignal(!initialPanelPreferences.mediaCollapsed);
  const [tasksOpen, setTasksOpen] = createSignal(
    initialNarrowViewport
      ? initialPanelPreferences.mediaCollapsed && !initialPanelPreferences.segmentsCollapsed
      : !initialPanelPreferences.segmentsCollapsed,
  );
  const [queueOpen, setQueueOpen] = createSignal(false);
  let queueDismissed = false;
  let mediaToggle: HTMLButtonElement | undefined;
  let tasksToggle: HTMLButtonElement | undefined;
  let shortcutClose: HTMLButtonElement | undefined;
  let projectMenu: HTMLDetailsElement | undefined;
  type ResizablePanel = "media" | "segments";
  let resizeState: { panel: ResizablePanel; startX: number; startWidth: number } | undefined;

  const focusPanel = (panel: ResizablePanel) => {
    requestAnimationFrame(() => {
      const target = panel === "media" ? "media-heading" : `${activeTask()}-tab`;
      document.getElementById(target)?.focus();
    });
  };
  const restoreTriggerFocus = (panel: ResizablePanel) => {
    requestAnimationFrame(() => (panel === "media" ? mediaToggle : tasksToggle)?.focus());
  };
  const openMediaPanel = (focus = true) => {
    setMediaCollapsed(false);
    setMediaOpen(true);
    if (narrowViewport()) setTasksOpen(false);
    if (focus) focusPanel("media");
  };
  const closeMediaPanel = (restoreFocus = true) => {
    setMediaCollapsed(true);
    setMediaOpen(false);
    if (restoreFocus && narrowViewport()) restoreTriggerFocus("media");
  };
  const toggleMediaPanel = () => (mediaOpen() ? closeMediaPanel() : openMediaPanel());
  const openTaskPanel = (task: (typeof taskTabs)[number], focus = true) => {
    setSettingsOpen(false);
    setActiveTask(task);
    setSegmentsCollapsed(false);
    setTasksOpen(true);
    if (narrowViewport()) setMediaOpen(false);
    if (focus) requestAnimationFrame(() => document.getElementById(`${task}-tab`)?.focus());
  };
  const closeTaskPanel = (restoreFocus = true) => {
    setSegmentsCollapsed(true);
    setTasksOpen(false);
    if (restoreFocus && narrowViewport()) restoreTriggerFocus("segments");
  };
  const toggleTaskPanel = () => (tasksOpen() ? closeTaskPanel() : openTaskPanel(activeTask()));
  const closeOpenDrawer = () => {
    if (mediaOpen()) closeMediaPanel();
    else if (tasksOpen()) closeTaskPanel();
  };
  const resetPanelWidth = (panel: ResizablePanel) => {
    const defaults = defaultPanelPreferences();
    const next = clampPanelPreferences(
      {
        mediaWidth: panel === "media" ? defaults.mediaWidth : mediaWidth(),
        segmentsWidth: panel === "segments" ? defaults.segmentsWidth : segmentsWidth(),
        mediaCollapsed: mediaCollapsed(),
        segmentsCollapsed: segmentsCollapsed(),
      },
      window.innerWidth,
    );
    setMediaWidth(next.mediaWidth);
    setSegmentsWidth(next.segmentsWidth);
  };
  const updatePanelWidth = (panel: ResizablePanel, value: number) => {
    const next = clampPanelPreferences(
      {
        mediaWidth: panel === "media" ? value : mediaWidth(),
        segmentsWidth: panel === "segments" ? value : segmentsWidth(),
        mediaCollapsed: mediaCollapsed(),
        segmentsCollapsed: segmentsCollapsed(),
      },
      window.innerWidth,
    );
    setMediaWidth(next.mediaWidth);
    setSegmentsWidth(next.segmentsWidth);
  };
  const resizePanelWithKeyboard = (panel: ResizablePanel, event: KeyboardEvent) => {
    if (event.key === "Escape" && resizeState?.panel === panel) {
      event.preventDefault();
      updatePanelWidth(panel, resizeState.startWidth);
      finishPanelResize();
      return;
    }
    if (event.key === "Home" || event.key.toLowerCase() === "r") {
      event.preventDefault();
      resetPanelWidth(panel);
      return;
    }
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const delta =
      panel === "media"
        ? event.key === "ArrowRight"
          ? 16
          : -16
        : event.key === "ArrowLeft"
          ? 16
          : -16;
    updatePanelWidth(panel, (panel === "media" ? mediaWidth() : segmentsWidth()) + delta);
  };
  const beginPanelResize = (panel: ResizablePanel, event: PointerEvent) => {
    if (narrowViewport()) return;
    event.preventDefault();
    resizeState = {
      panel,
      startX: event.clientX,
      startWidth: panel === "media" ? mediaWidth() : segmentsWidth(),
    };
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Window-level handlers keep resizing available when pointer capture is unsupported.
    }
  };
  const updatePanelResize = (event: PointerEvent) => {
    if (!resizeState) return;
    const direction = resizeState.panel === "media" ? 1 : -1;
    updatePanelWidth(
      resizeState.panel,
      resizeState.startWidth + (event.clientX - resizeState.startX) * direction,
    );
  };
  const finishPanelResize = () => {
    resizeState = undefined;
  };
  const closeProjectMenu = () => projectMenu?.removeAttribute("open");
  const openHelp = () => {
    closeProjectMenu();
    controller.setShortcutHelpOpen(true);
  };
  const loadProjectFromMenu = () => {
    closeProjectMenu();
    const id = window.prompt("Project ID to load", "");
    if (id) void controller.projects.loadProject(id);
  };
  const undo = () => controller.undo();
  const redo = () => controller.redo();
  createEffect(() => {
    if (controller.shortcutHelpOpen()) queueMicrotask(() => shortcutClose?.focus());
  });
  createEffect(() => {
    const current = {
      mediaWidth: mediaWidth(),
      segmentsWidth: segmentsWidth(),
      mediaCollapsed: mediaCollapsed(),
      segmentsCollapsed: segmentsCollapsed(),
    };
    const next = narrowViewport() ? current : clampPanelPreferences(current, window.innerWidth);
    if (next.mediaWidth !== current.mediaWidth) setMediaWidth(next.mediaWidth);
    if (next.segmentsWidth !== current.segmentsWidth) setSegmentsWidth(next.segmentsWidth);
    try {
      window.localStorage.setItem(PANEL_PREFERENCES_KEY, serializePanelPreferences(next));
    } catch {
      // Panel preferences are optional and should not interrupt editing.
    }
  });
  createEffect(() => {
    const batches = controller.batches();
    if (!batches.length) queueDismissed = false;
    else if (!queueDismissed) setQueueOpen(true);
  });
  createEffect(() => {
    const handleResize = () => {
      const nextNarrow = window.innerWidth < 1050;
      const wasNarrow = narrowViewport();
      setNarrowViewport(nextNarrow);
      if (nextNarrow && !wasNarrow && mediaOpen() && tasksOpen()) setTasksOpen(false);
      if (!nextNarrow && wasNarrow) {
        setMediaOpen(!mediaCollapsed());
        setTasksOpen(!segmentsCollapsed());
        const next = clampPanelPreferences(
          {
            mediaWidth: mediaWidth(),
            segmentsWidth: segmentsWidth(),
            mediaCollapsed: mediaCollapsed(),
            segmentsCollapsed: segmentsCollapsed(),
          },
          window.innerWidth,
        );
        setMediaWidth(next.mediaWidth);
        setSegmentsWidth(next.segmentsWidth);
      }
    };
    window.addEventListener("resize", handleResize);
    onCleanup(() => window.removeEventListener("resize", handleResize));
  });
  createEffect(() => {
    window.addEventListener("pointermove", updatePanelResize);
    window.addEventListener("pointerup", finishPanelResize);
    window.addEventListener("pointercancel", finishPanelResize);
    onCleanup(() => {
      window.removeEventListener("pointermove", updatePanelResize);
      window.removeEventListener("pointerup", finishPanelResize);
      window.removeEventListener("pointercancel", finishPanelResize);
    });
  });
  const moveTask = (current: (typeof taskTabs)[number], direction: number) => {
    const start = taskTabs.indexOf(current);
    for (let offset = 1; offset <= taskTabs.length; offset += 1) {
      const candidate = taskTabs[(start + direction * offset + taskTabs.length) % taskTabs.length];
      if (candidate !== "detection" || selected()) {
        setActiveTask(candidate);
        document.getElementById(`${candidate}-tab`)?.focus();
        return;
      }
    }
  };
  const activeJobCount = () =>
    controller.batches().filter((batch) => batch.state === "queued" || batch.state === "running")
      .length;
  const failedJobCount = () =>
    controller.batches().filter((batch) => batch.state === "failed").length;
  return (
    <WorkspaceProvider value={controller}>
      <main
        class="app-shell"
        aria-label="VideoCutlist segment selection"
        style={`--media-panel-width:${mediaWidth()}px;--segments-panel-width:${segmentsWidth()}px;--media-handle-width:${mediaOpen() ? 12 : 0}px;--segments-handle-width:${tasksOpen() ? 12 : 0}px`}
        onKeyDown={(event) => {
          if (
            narrowViewport() &&
            event.key === "Escape" &&
            !event.target.closest("[role='dialog']") &&
            (mediaOpen() || tasksOpen())
          ) {
            event.preventDefault();
            closeOpenDrawer();
          }
        }}
      >
        <header class="workspace-action-row" aria-label="Workspace actions">
          <div class="workspace-actions-start">
            <details class="dropdown workspace-menu" ref={(element) => (projectMenu = element)}>
              <summary class="btn btn-ghost btn-sm">Project</summary>
              <ul class="dropdown-content menu menu-sm z-50 w-60 rounded-box bg-base-200 p-2 shadow-lg">
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      closeProjectMenu();
                      openTaskPanel("project");
                    }}
                  >
                    Open project panel
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      closeProjectMenu();
                      controller.projects.newProject();
                    }}
                  >
                    New project
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      closeProjectMenu();
                      void controller.projects.saveProject();
                    }}
                  >
                    Save project
                  </button>
                </li>
                <li>
                  <button type="button" onClick={loadProjectFromMenu}>
                    Load project
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      closeProjectMenu();
                      openMediaPanel();
                    }}
                  >
                    Media library
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => {
                      closeProjectMenu();
                      openTaskPanel("project");
                    }}
                  >
                    Interchange tools
                  </button>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={() => (settingsOpen() ? setSettingsOpen(false) : void openSettings())}
                  >
                    {settingsOpen() ? "Back to editor" : "Settings"}
                  </button>
                </li>
                <li>
                  <button type="button" onClick={openHelp}>
                    Keyboard help
                  </button>
                </li>
                <li class="menu-title panel-menu-title">Panel layout</li>
                <li>
                  <button type="button" onClick={() => resetPanelWidth("media")}>
                    Reset media panel size
                  </button>
                </li>
                <li>
                  <button type="button" onClick={() => resetPanelWidth("segments")}>
                    Reset segments panel size
                  </button>
                </li>
              </ul>
            </details>
            <h1 class="workspace-brand" tabIndex={-1}>
              VideoCutList
            </h1>
            <span class="project-status" aria-label="Project status">
              <strong>{projectName()}</strong>
              <span role="status">
                {projectSaveState() === "saving"
                  ? "Saving"
                  : projectSaveState() === "failed"
                    ? "Save failed"
                    : projectSaveState() === "unsaved"
                      ? revision() === 0
                        ? "Unsaved"
                        : "Unsaved changes"
                      : "Saved"}
              </span>
            </span>
          </div>
          <div class="workspace-actions-center" aria-label="History controls">
            <button
              class="btn btn-ghost btn-sm btn-square"
              aria-label="Undo"
              aria-keyshortcuts="Control+Z Meta+Z"
              disabled={!controller.timeline().past.length}
              onClick={undo}
            >
              <Undo2 size={16} aria-hidden="true" />
            </button>
            <button
              class="btn btn-ghost btn-sm btn-square"
              aria-label="Redo"
              aria-keyshortcuts="Control+Y Meta+Shift+Z"
              disabled={!controller.timeline().future.length}
              onClick={redo}
            >
              <Redo2 size={16} aria-hidden="true" />
            </button>
          </div>
          <div class="workspace-actions-end">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              aria-label={`Jobs${activeJobCount() ? `, ${activeJobCount()} active` : ""}${failedJobCount() ? `, ${failedJobCount()} failed` : ""}`}
              aria-expanded={queueOpen()}
              aria-controls="queue-panel"
              onClick={() => {
                const nextOpen = !queueOpen();
                queueDismissed = !nextOpen;
                setQueueOpen(nextOpen);
                openTaskPanel(activeTask(), false);
              }}
            >
              Jobs{" "}
              <span class="job-count" aria-hidden="true">
                {activeJobCount() || failedJobCount() || ""}
              </span>
            </button>
            <button
              class="btn btn-primary btn-sm"
              type="button"
              aria-label={`Export ${controller.present().segments.length} segments`}
              onClick={() => openTaskPanel("export")}
            >
              <span>Export</span>
              <span class="export-count" aria-hidden="true">
                {controller.present().segments.length}
              </span>
            </button>
            <button
              ref={(element) => (mediaToggle = element)}
              class="btn btn-ghost btn-sm drawer-button"
              type="button"
              aria-label={mediaOpen() ? "Collapse media panel" : "Expand media panel"}
              title={mediaOpen() ? "Collapse media panel" : "Expand media panel"}
              aria-expanded={mediaOpen()}
              aria-controls="media-panel"
              onClick={toggleMediaPanel}
            >
              Media
            </button>
            <button
              ref={(element) => (tasksToggle = element)}
              class="btn btn-ghost btn-sm drawer-button"
              type="button"
              aria-label={tasksOpen() ? "Collapse segments panel" : "Expand segments panel"}
              title={tasksOpen() ? "Collapse segments panel" : "Expand segments panel"}
              aria-expanded={tasksOpen()}
              aria-controls="segments-panel"
              onClick={toggleTaskPanel}
            >
              Segments
            </button>
            <button
              class="btn btn-ghost btn-sm workspace-settings-action"
              type="button"
              aria-label={settingsOpen() ? "Back to editor" : "Settings"}
              onClick={() => (settingsOpen() ? setSettingsOpen(false) : void openSettings())}
            >
              <Settings size={16} aria-hidden="true" />
              <span class="hidden sm:inline">{settingsOpen() ? "Back to editor" : "Settings"}</span>
            </button>
          </div>
        </header>
        <Show when={controller.shortcutHelpOpen()}>
          <dialog
            open
            class="modal modal-open"
            role="dialog"
            aria-modal="true"
            aria-labelledby="shortcut-help-heading"
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                controller.setShortcutHelpOpen(false);
              }
            }}
          >
            <div class="modal-box">
              <h2 id="shortcut-help-heading" class="text-lg font-bold">
                Keyboard shortcuts
              </h2>
              <p class="shortcut-help">
                Shortcuts work while reviewing the timeline, not while typing.
              </p>
              <div
                class="grid grid-cols-1 gap-2 sm:grid-cols-2"
                aria-label="Keyboard shortcut reference"
              >
                <span>
                  <kbd class="kbd kbd-sm">Space</kbd> Play or pause
                </span>
                <span>
                  <kbd class="kbd kbd-sm">←</kbd> <kbd class="kbd kbd-sm">→</kbd> Seek one second
                </span>
                <span>
                  <kbd class="kbd kbd-sm">,</kbd> <kbd class="kbd kbd-sm">.</kbd> Preview step
                </span>
                <span>
                  <kbd class="kbd kbd-sm">←</kbd> <kbd class="kbd kbd-sm">→</kbd> Nudge a selected
                  boundary by 100 ms
                </span>
                <span>
                  <kbd class="kbd kbd-sm">I</kbd> / <kbd class="kbd kbd-sm">O</kbd> Set In / Out
                </span>
                <span>
                  <kbd class="kbd kbd-sm">C</kbd> Start a new segment draft
                </span>
                <span>
                  <kbd class="kbd kbd-sm">P</kbd> Play active cut
                </span>
                <span>
                  <kbd class="kbd kbd-sm">L</kbd> Loop active cut
                </span>
                <span>
                  <kbd class="kbd kbd-sm">R</kbd> Preview cuts in order
                </span>
                <span>
                  <kbd class="kbd kbd-sm">B</kbd> Split active cut
                </span>
                <span>
                  <kbd class="kbd kbd-sm">Delete</kbd> / <kbd class="kbd kbd-sm">Backspace</kbd>{" "}
                  Remove active cut
                </span>
                <span>
                  <kbd class="kbd kbd-sm">Ctrl/Cmd+Z</kbd> Undo
                </span>
                <span>
                  <kbd class="kbd kbd-sm">Ctrl/Cmd+Y</kbd> Redo
                </span>
                <span>
                  <kbd class="kbd kbd-sm">E</kbd> Create clips
                </span>
                <span>
                  <kbd class="kbd kbd-sm">A</kbd> / <kbd class="kbd kbd-sm">Y</kbd> Accept detection
                  candidate
                </span>
                <span>
                  <kbd class="kbd kbd-sm">R</kbd> / <kbd class="kbd kbd-sm">X</kbd> /{" "}
                  <kbd class="kbd kbd-sm">N</kbd> / <kbd class="kbd kbd-sm">Delete</kbd> /{" "}
                  <kbd class="kbd kbd-sm">Backspace</kbd> Reject detection candidate
                </span>
                <span>
                  <kbd class="kbd kbd-sm">Shift+/</kbd> Open this reference
                </span>
                <span>
                  <kbd class="kbd kbd-sm">Esc</kbd> Start a new segment draft
                </span>
              </div>
              <div class="modal-action">
                <button
                  ref={(element) => (shortcutClose = element)}
                  class="btn btn-primary"
                  type="button"
                  onClick={() => controller.setShortcutHelpOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
            <form method="dialog" class="modal-backdrop">
              <button
                type="button"
                aria-label="Close shortcut help"
                onClick={() => controller.setShortcutHelpOpen(false)}
              />
            </form>
          </dialog>
        </Show>
        <Show when={narrowViewport() && (mediaOpen() || tasksOpen())}>
          <button
            class="drawer-backdrop"
            type="button"
            aria-label="Close open panel"
            onClick={closeOpenDrawer}
          />
        </Show>
        <aside
          id="media-panel"
          class="left-sidebar"
          classList={{
            "is-collapsed": !mediaOpen(),
            "drawer-open": narrowViewport() && mediaOpen(),
          }}
          aria-label="Media workspace"
          aria-hidden={!mediaOpen()}
          role={narrowViewport() ? "dialog" : undefined}
          aria-modal={narrowViewport() ? "true" : undefined}
        >
          <header class="app-header">
            <div class="app-heading">
              <h2 id="media-heading" tabIndex={-1}>
                Media
              </h2>
            </div>
            <button
              class="btn btn-ghost btn-sm drawer-close"
              type="button"
              aria-label="Close media panel"
              onClick={() => closeMediaPanel()}
            >
              Close
            </button>
          </header>
          <Show when={!settingsOpen()}>
            <LibraryView />
          </Show>
        </aside>
        <div
          class="panel-resizer media-resizer"
          classList={{ "is-collapsed": !mediaOpen() || settingsOpen() }}
          role="separator"
          aria-label="Resize media panel"
          aria-orientation="vertical"
          aria-valuemin="200"
          aria-valuemax="360"
          aria-valuenow={mediaWidth()}
          tabIndex={0}
          onPointerDown={(event) => beginPanelResize("media", event)}
          onDblClick={() => resetPanelWidth("media")}
          onKeyDown={(event) => resizePanelWithKeyboard("media", event)}
        />
        <Show
          when={settingsOpen()}
          fallback={
            <>
              <EditorView
                onChooseMedia={() => {
                  openMediaPanel(false);
                  requestAnimationFrame(() => {
                    const target =
                      document.querySelector<HTMLElement>(".media-list button") ??
                      document.getElementById("media-heading");
                    target?.focus();
                    target?.scrollIntoView({ block: "nearest" });
                  });
                }}
              />
              <div
                class="panel-resizer segments-resizer"
                classList={{ "is-collapsed": !tasksOpen() }}
                role="separator"
                aria-label="Resize segments panel"
                aria-orientation="vertical"
                aria-valuemin="200"
                aria-valuemax="420"
                aria-valuenow={segmentsWidth()}
                tabIndex={0}
                onPointerDown={(event) => beginPanelResize("segments", event)}
                onDblClick={() => resetPanelWidth("segments")}
                onKeyDown={(event) => resizePanelWithKeyboard("segments", event)}
              />
              <aside
                id="segments-panel"
                class="task-panel"
                classList={{
                  "is-collapsed": !tasksOpen(),
                  "drawer-open": narrowViewport() && tasksOpen(),
                }}
                aria-label="Segments and workspace tasks"
                aria-hidden={!tasksOpen()}
                role={narrowViewport() ? "dialog" : undefined}
                aria-modal={narrowViewport() ? "true" : undefined}
              >
                <div class="task-panel-toolbar">
                  <span>Segments and tasks</span>
                  <div class="task-panel-toolbar-actions">
                    <button
                      class="btn btn-ghost btn-xs"
                      type="button"
                      aria-label="Reset segments panel size"
                      onClick={() => resetPanelWidth("segments")}
                    >
                      Reset size
                    </button>
                    <button
                      class="btn btn-ghost btn-xs drawer-close"
                      type="button"
                      aria-label="Close segments panel"
                      onClick={() => closeTaskPanel()}
                    >
                      Close
                    </button>
                  </div>
                </div>
                <div class="task-tabs tabs" role="tablist" aria-label="Workspace tasks">
                  <button
                    id="cuts-tab"
                    class="tab"
                    role="tab"
                    type="button"
                    aria-selected={activeTask() === "cuts"}
                    aria-controls="cuts-tabpanel"
                    tabIndex={activeTask() === "cuts" ? 0 : -1}
                    onClick={() => setActiveTask("cuts")}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                        event.preventDefault();
                        moveTask("cuts", 1);
                      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                        event.preventDefault();
                        moveTask("cuts", -1);
                      }
                    }}
                  >
                    Cuts
                  </button>
                  <button
                    id="project-tab"
                    class="tab"
                    role="tab"
                    type="button"
                    aria-selected={activeTask() === "project"}
                    aria-controls="project-tabpanel"
                    tabIndex={activeTask() === "project" ? 0 : -1}
                    onClick={() => setActiveTask("project")}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                        event.preventDefault();
                        moveTask("project", 1);
                      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                        event.preventDefault();
                        moveTask("project", -1);
                      }
                    }}
                  >
                    Project
                  </button>
                  <button
                    id="export-tab"
                    class="tab"
                    role="tab"
                    type="button"
                    aria-selected={activeTask() === "export"}
                    aria-controls="export-tabpanel"
                    tabIndex={activeTask() === "export" ? 0 : -1}
                    onClick={() => setActiveTask("export")}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                        event.preventDefault();
                        moveTask("export", 1);
                      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                        event.preventDefault();
                        moveTask("export", -1);
                      }
                    }}
                  >
                    Export
                  </button>
                  <button
                    id="detection-tab"
                    class="tab"
                    role="tab"
                    type="button"
                    aria-selected={activeTask() === "detection"}
                    aria-controls="detection-tabpanel"
                    tabIndex={activeTask() === "detection" ? 0 : -1}
                    disabled={!selected() || !controller.activeItemId()}
                    onClick={() => setActiveTask("detection")}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                        event.preventDefault();
                        moveTask("detection", 1);
                      } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                        event.preventDefault();
                        moveTask("detection", -1);
                      }
                    }}
                  >
                    Detection
                  </button>
                </div>
                <div
                  id="cuts-tabpanel"
                  role="tabpanel"
                  aria-labelledby="cuts-tab"
                  hidden={activeTask() !== "cuts"}
                >
                  <CutsView />
                </div>
                <div
                  id="project-tabpanel"
                  role="tabpanel"
                  aria-labelledby="project-tab"
                  hidden={activeTask() !== "project"}
                >
                  <ProjectsView />
                </div>
                <div
                  id="export-tabpanel"
                  role="tabpanel"
                  aria-labelledby="export-tab"
                  hidden={activeTask() !== "export"}
                >
                  <ExportView />
                </div>
                <div
                  id="detection-tabpanel"
                  role="tabpanel"
                  aria-labelledby="detection-tab"
                  hidden={activeTask() !== "detection"}
                >
                  <DetectionView />
                </div>
                <Show when={queueOpen()}>
                  <div id="queue-panel">
                    <QueueView />
                  </div>
                </Show>
              </aside>
            </>
          }
        >
          <SettingsView />
        </Show>
      </main>
    </WorkspaceProvider>
  );
}
