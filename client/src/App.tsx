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

export function App() {
  const controller = createWorkspaceController();
  const {
    selected,
    projectName,
    revision,
    dirty,
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
  createEffect(() => {
    const hasSelectedMedia = Boolean(selected());
    if (hasSelectedMedia && !hadSelectedMedia)
      queueMicrotask(() => {
        if (dirty() || !controller.activeItemId()) setActiveTask("cuts");
      });
    hadSelectedMedia = hasSelectedMedia;
  });
  const taskTabs = ["cuts", "project", "export", "detection"] as const;
  const [mediaOpen, setMediaOpen] = createSignal(true);
  const [tasksOpen, setTasksOpen] = createSignal(true);
  const undo = () => controller.undo();
  const redo = () => controller.redo();
  let shortcutClose: HTMLButtonElement | undefined;
  createEffect(() => {
    if (controller.shortcutHelpOpen()) queueMicrotask(() => shortcutClose?.focus());
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
  return (
    <WorkspaceProvider value={controller}>
      <main class="app-shell" aria-label="VideoCutlist segment selection">
        <header class="navbar app-navbar">
          <div class="navbar-start gap-3">
            <button
              class="btn btn-ghost btn-sm drawer-button"
              type="button"
              aria-label="Toggle Media sidebar"
              aria-expanded={mediaOpen()}
              onClick={() => setMediaOpen((open) => !open)}
            >
              ☰
            </button>
            <h1 class="text-base font-bold" tabIndex={-1}>
              VideoCutList
            </h1>
            <span class="project-status" aria-label="Project status">
              <strong>{projectName()}</strong>
              <span role="status">
                {revision() === 0 ? "Unsaved" : dirty() ? "Unsaved changes" : "Saved"}
              </span>
            </span>
          </div>
          <div class="navbar-center hidden md:flex gap-1">
            <button
              class="btn btn-ghost btn-sm"
              aria-label="Undo"
              aria-keyshortcuts="Control+Z Meta+Z"
              disabled={!controller.timeline().past.length}
              onClick={undo}
            >
              <Undo2 size={16} />
            </button>
            <button
              class="btn btn-ghost btn-sm"
              aria-label="Redo"
              aria-keyshortcuts="Control+Y Meta+Shift+Z"
              disabled={!controller.timeline().future.length}
              onClick={redo}
            >
              <Redo2 size={16} />
            </button>
          </div>
          <div class="navbar-end gap-1">
            <button
              class="btn btn-ghost btn-sm"
              type="button"
              aria-label={settingsOpen() ? "Back to editor" : "Settings"}
              onClick={() => (settingsOpen() ? setSettingsOpen(false) : void openSettings())}
            >
              <Settings size={16} />
              <span class="hidden sm:inline">{settingsOpen() ? "Back to editor" : "Settings"}</span>
            </button>
            <button
              class="btn btn-primary btn-sm"
              type="button"
              onClick={() => {
                setSettingsOpen(false);
                setTasksOpen(true);
                setActiveTask("export");
              }}
            >
              <span>Export</span>
            </button>
            <button
              class="btn btn-ghost btn-sm drawer-button"
              type="button"
              aria-label="Toggle task sidebar"
              aria-expanded={tasksOpen()}
              onClick={() => setTasksOpen((open) => !open)}
            >
              ☷
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
                  <kbd class="kbd kbd-sm">,</kbd> <kbd class="kbd kbd-sm">.</kbd> Step one frame
                </span>
                <span>
                  <kbd class="kbd kbd-sm">I</kbd> / <kbd class="kbd kbd-sm">O</kbd> Set In / Out
                </span>
                <span>
                  <kbd class="kbd kbd-sm">C</kbd> Commit draft cut
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
                  <kbd class="kbd kbd-sm">Esc</kbd> Leave active editing
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
        <aside
          class="left-sidebar"
          classList={{ "is-collapsed": !mediaOpen() }}
          aria-label="Media workspace"
        >
          <header class="app-header">
            <div class="app-heading">
              <h2 id="media-heading" tabIndex={-1}>
                Media
              </h2>
            </div>
          </header>
          <Show when={!settingsOpen()}>
            <LibraryView />
          </Show>
        </aside>
        <Show
          when={settingsOpen()}
          fallback={
            <>
              <EditorView
                onChooseMedia={() => {
                  setMediaOpen(true);
                  requestAnimationFrame(() => {
                    const target =
                      document.querySelector<HTMLElement>(".media-list button") ??
                      document.getElementById("media-heading");
                    target?.focus();
                    target?.scrollIntoView({ block: "nearest" });
                  });
                }}
              />
              <aside
                class="task-panel"
                classList={{ "is-collapsed": !tasksOpen() }}
                aria-label="Workspace tasks"
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
                <QueueView />
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
