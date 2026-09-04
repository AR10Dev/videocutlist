import { createSignal, Show } from "solid-js";
import { DetectionView } from "./features/detection/DetectionView";
import { EditorView } from "./features/editor/EditorView";
import { ExportView } from "./features/export/ExportView";
import { LibraryView } from "./features/media/LibraryView";
import { ProjectsView } from "./features/projects/ProjectsView";
import { QueueView } from "./features/queue/QueueView";
import { SettingsView } from "./features/settings/SettingsView";
import { createWorkspaceController } from "./features/app/controller";
import { WorkspaceProvider } from "./features/app/WorkspaceContext";

export function App() {
  const controller = createWorkspaceController();
  const { selected, projectName, revision, dirty, settingsOpen, openSettings } = controller;
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
        <header class="app-header">
          <div class="app-heading">
            <h1>VideoCutlist</h1>
            <div class="project-status" aria-label="Project status">
              <strong>{revision() > 0 ? projectName() : "Unsaved project"}</strong>
              <span>{dirty() || revision() === 0 ? "Unsaved" : "Saved"}</span>
            </div>
          </div>
          <button
            class="settings-button"
            type="button"
            aria-label="Settings"
            aria-pressed={settingsOpen() ? "true" : "false"}
            title="Settings"
            onClick={() => void openSettings()}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20">
              <path d="m9.7 2-.4 2a8 8 0 0 0-1.8 1l-1.8-1-1.7 1.7 1 1.8a8 8 0 0 0-1 1.8l-2 .4v2.4l2 .4a8 8 0 0 0 1 1.8l-1 1.8 1.7 1.7 1.8-1a8 8 0 0 0 1.8 1l.4 2h2.4l.4-2a8 8 0 0 0 1.8-1l1.8 1 1.7-1.7-1-1.8a8 8 0 0 0 1-1.8l2-.4V9.7l-2-.4a8 8 0 0 0-1-1.8l1-1.8-1.7-1.7-1.8 1a8 8 0 0 0-1.8-1l-.4-2zM11 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8" />
            </svg>
            <span>Settings</span>
          </button>
        </header>
        <Show
          when={settingsOpen()}
          fallback={
            <>
              <LibraryView />
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
                <Show when={activeTask() === "project"}>
                  <div id="project-tabpanel" role="tabpanel" aria-labelledby="project-tab">
                    <ProjectsView />
                  </div>
                </Show>
                <Show when={activeTask() === "export"}>
                  <div id="export-tabpanel" role="tabpanel" aria-labelledby="export-tab">
                    <ExportView />
                  </div>
                </Show>
                <Show when={activeTask() === "detection" && selected()}>
                  <div id="detection-tabpanel" role="tabpanel" aria-labelledby="detection-tab">
                    <DetectionView />
                  </div>
                </Show>
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
