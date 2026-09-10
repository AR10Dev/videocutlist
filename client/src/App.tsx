import { createEffect, onCleanup, Show } from "solid-js";
import {
  AlertCircle,
  CheckCircle2,
  CircleHelp,
  Ellipsis,
  FolderOpen,
  LoaderCircle,
  Save,
  Settings,
} from "lucide-solid";
import { DetectionView } from "./features/detection/DetectionView";
import { CutsView } from "./features/editor/CutsView";
import { EditorView } from "./features/editor/EditorView";
import { ExportView } from "./features/export/ExportView";
import { LibraryView } from "./features/media/LibraryView";
import { SettingsView } from "./features/settings/SettingsView";
import { createWorkspaceController } from "./features/app/controller";
import { createWorkspacePanelController } from "./features/app/panelController";
import { WorkspaceProvider } from "./features/app/WorkspaceContext";
import { applyAppearance } from "./features/settings/model";

export function App() {
  const controller = createWorkspaceController();
  const {
    selected,
    projectName,
    revision,
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
  const panel = createWorkspacePanelController({
    selected,
    activeItem: controller.activeItemId,
    dirty: controller.dirty,
    segmentCount: () => controller.present().segments.length,
    setSettingsOpen,
  });
  const {
    activeTask,
    setActiveTask,
    narrowViewport,
    mediaWidth,
    segmentsWidth,
    mediaOpen,
    tasksOpen,
    openMediaPanel,
    closeMediaPanel,
    hideMediaPanel,
    openTaskPanel,
    closeTaskPanel,
    closeOpenDrawer,
    resetPanelWidth,
    resizePanelWithKeyboard,
    beginPanelResize,
    moveTask,
  } = panel;
  let shortcutClose: HTMLButtonElement | undefined;
  let projectMenu: HTMLDetailsElement | undefined;

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
  const toggleSettings = () => {
    if (settingsOpen()) {
      setSettingsOpen(false);
      openMediaPanel(false);
      return;
    }
    if (mediaOpen()) hideMediaPanel();
    closeTaskPanel(false);
    void openSettings();
  };
  createEffect(() => {
    if (controller.shortcutHelpOpen()) queueMicrotask(() => shortcutClose?.focus());
  });
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
                  <kbd class="kbd kbd-sm">←</kbd> <kbd class="kbd kbd-sm">→</kbd> Resize a focused
                  panel separator by 16 px
                </span>
                <span>
                  <kbd class="kbd kbd-sm">Home</kbd> / <kbd class="kbd kbd-sm">R</kbd> Reset a
                  focused panel separator
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
          <header class="project-sidebar-header" aria-label="Project controls">
            <div class="project-identity">
              <strong title={projectName()}>{projectName()}</strong>
              <span
                class="project-save-state"
                aria-label="Project status"
                role="status"
                title={
                  projectSaveState() === "failed"
                    ? controller.status() || "Save failed. Try again."
                    : undefined
                }
              >
                {projectSaveState() === "saving" ? (
                  <>
                    <LoaderCircle class="spin" size={13} aria-hidden="true" /> Saving…
                  </>
                ) : projectSaveState() === "failed" ? (
                  <>
                    <AlertCircle size={13} aria-hidden="true" /> Save failed
                  </>
                ) : projectSaveState() === "unsaved" ? (
                  <>
                    <span class="status-dot" aria-hidden="true" />
                    {revision() === 0 ? "Not saved yet" : "Unsaved changes"}
                  </>
                ) : (
                  <>
                    <CheckCircle2 size={13} aria-hidden="true" /> Saved
                  </>
                )}
              </span>
            </div>
            <div class="project-header-actions">
              <button
                class="btn btn-ghost btn-sm btn-square"
                type="button"
                title={projectSaveState() === "failed" ? "Retry save" : "Save project"}
                aria-label="Save project from project header"
                disabled={projectSaveState() === "saving"}
                onClick={() => void controller.projects.saveProject()}
              >
                <Save size={16} aria-hidden="true" />
              </button>
              <button
                class="btn btn-ghost btn-sm btn-square"
                type="button"
                title={settingsOpen() ? "Back to editor" : "Settings"}
                aria-label={settingsOpen() ? "Back to editor" : "Settings"}
                onClick={toggleSettings}
              >
                <Settings size={16} aria-hidden="true" />
              </button>
              <details class="project-menu dropdown" ref={(element) => (projectMenu = element)}>
                <summary class="btn btn-ghost btn-sm btn-square" title="Project menu">
                  <Ellipsis size={17} aria-hidden="true" />
                  <span class="sr-only">Project menu</span>
                </summary>
                <ul class="dropdown-content menu menu-sm z-50 w-60 rounded-box bg-base-200 p-2 shadow-lg">
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
                    <button type="button" onClick={loadProjectFromMenu}>
                      <FolderOpen size={15} aria-hidden="true" /> Load project
                    </button>
                  </li>
                  <li>
                    <button type="button" onClick={openHelp}>
                      <CircleHelp size={15} aria-hidden="true" /> Keyboard help
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
                      Reset tasks panel size
                    </button>
                  </li>
                </ul>
              </details>
            </div>
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
                mediaOpen={mediaOpen()}
                tasksOpen={tasksOpen()}
                openMediaPanel={() => (mediaOpen() ? closeMediaPanel() : openMediaPanel())}
                openTaskPanel={() => (tasksOpen() ? closeTaskPanel() : openTaskPanel(activeTask()))}
                onChooseMedia={() => {
                  openMediaPanel(false);
                  requestAnimationFrame(() => {
                    const target =
                      document.querySelector<HTMLElement>(".media-list button") ??
                      document.querySelector<HTMLElement>(
                        "#media-panel .media-panel .panel-heading button",
                      );
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
                    Auto-detect
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
              </aside>
            </>
          }
        >
          <SettingsView
            onClose={() => {
              setSettingsOpen(false);
              openMediaPanel(false);
            }}
          />
        </Show>
      </main>
    </WorkspaceProvider>
  );
}
