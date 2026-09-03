import { Show } from "solid-js";
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
  const { selected, status, settingsOpen, openSettings } = controller;
  return (
    <WorkspaceProvider value={controller}>
      <main class="app-shell" aria-label="VideoCutlist segment selection">
        <header class="app-header">
          <h1>VideoCutlist</h1>
          <p role="status" aria-live="polite">
            {status()}
          </p>
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
              <ProjectsView />
              <ExportView />
              <Show when={selected()}>
                <DetectionView />
              </Show>
              <QueueView />
            </>
          }
        >
          <SettingsView />
        </Show>
      </main>
    </WorkspaceProvider>
  );
}
