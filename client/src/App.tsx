import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import { Settings } from "lucide-solid";
import { DetectionView } from "./features/detection/DetectionView";
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
  const [activeTask, setActiveTask] = createSignal<"project" | "export" | "detection">("project");
  const taskTabs = ["project", "export", "detection"] as const;
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
        <aside class="left-sidebar" aria-label="Media workspace">
          <header class="app-header">
            <div class="app-heading">
              <h1>VideoCutlist</h1>
              <div class="project-status" aria-label="Project status">
                <strong>{projectName()}</strong>
                <span role="status">
                  {revision() === 0 ? "Unsaved" : dirty() ? "Unsaved changes" : "Saved"}
                </span>
              </div>
            </div>
            <button
              class="settings-button btn btn-sm btn-square"
              type="button"
              aria-label={settingsOpen() ? "Back to editor" : "Settings"}
              aria-pressed={settingsOpen() ? "true" : "false"}
              title={settingsOpen() ? "Back to editor" : "Settings"}
              onClick={() => (settingsOpen() ? setSettingsOpen(false) : void openSettings())}
            >
              <Settings size={18} aria-hidden="true" />
              <span class="sr-only">{settingsOpen() ? "Back to editor" : "Settings"}</span>
            </button>
          </header>
          <Show when={!settingsOpen()}>
            <LibraryView />
          </Show>
        </aside>
        <Show
          when={settingsOpen()}
          fallback={
            <>
              <EditorView />
              <aside class="task-panel" aria-label="Workspace tasks">
                <div class="task-tabs" role="tablist" aria-label="Workspace tasks">
                  <button
                    id="project-tab"
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
                    role="tab"
                    type="button"
                    aria-selected={activeTask() === "detection"}
                    aria-controls="detection-tabpanel"
                    tabIndex={activeTask() === "detection" ? 0 : -1}
                    disabled={!selected()}
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
