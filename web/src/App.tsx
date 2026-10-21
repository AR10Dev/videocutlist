import { createEffect, onCleanup, Show } from "solid-js";
import { Dialog } from "@kobalte/core/dialog";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Tabs } from "@kobalte/core/tabs";
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
import { QueueView } from "./features/queue/QueueView";
import { ExportView } from "./features/export/ExportView";
import { LibraryView } from "./features/media/LibraryView";
import { SettingsView } from "./features/settings/SettingsView";
import { ProjectDialog } from "./features/projects/ProjectDialog";
import { ProjectConflictNotice, RecoveryNotice } from "./features/projects/ProjectNotices";
import { createWorkspaceController } from "./app/controller";
import { createWorkspacePanelController } from "./app/panelController";
import { WorkspaceProvider } from "./app/WorkspaceContext";
import {
  ConfirmationProvider,
  createConfirmation,
  discardChanges,
} from "./components/ConfirmDialog";
import { applyAppearance } from "./features/settings/model";

export function App() {
  const controller = createWorkspaceController();
  const confirmation = createConfirmation();
  const { selected, projectName, revision } = controller;
  const projectSaveState = controller.projects.saveState;
  const { settingsOpen, setSettingsOpen, openSettings, appearance } = controller.settings;
  createEffect(() => {
    const preference = appearance();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => applyAppearance(preference, media.matches);
    apply();
    if (preference === "system") media.addEventListener("change", apply);
    onCleanup(() => media.removeEventListener("change", apply));
  });
  const panel = createWorkspacePanelController({
    server: controller.server,
    selected,
    activeItem: controller.activeItemId,
    dirty: controller.dirty,
    segmentCount: () => controller.editor.present().segments.length,
    closeSettings: setSettingsOpen,
  });
  const {
    activeTask,
    selectTask,
    narrowViewport,
    mediaWidth,
    segmentsWidth,
    mediaOpen,
    tasksOpen,
    projectToolsOpen,
    setProjectToolsOpen,
    openMediaPanel,
    closeMediaPanel,
    openTaskPanel,
    closeTaskPanel,
    closeOpenDrawer,
    resetPanelWidth,
    resizePanelWithKeyboard,
    beginPanelResize,
  } = panel;
  let projectMenuTrigger: HTMLButtonElement | undefined;
  let shortcutReturnFocus: HTMLElement | undefined;
  let disposed = false;
  const scheduledFrames = new Set<number>();
  const scheduleFrame = (callback: () => void) => {
    const frame = requestAnimationFrame(() => {
      scheduledFrames.delete(frame);
      if (!disposed) callback();
    });
    scheduledFrames.add(frame);
  };
  const openHelp = () => {
    shortcutReturnFocus = projectMenuTrigger;
    controller.editor.setShortcutHelpOpen(true);
  };
  const loadProjectFromMenu = () => setProjectToolsOpen(true);
  const toggleSettings = () => {
    if (settingsOpen()) {
      setSettingsOpen(false);
      return;
    }
    void openSettings();
  };
  createEffect(() => {
    if (controller.projects.saveConflict()) openMediaPanel(false);
  });
  onCleanup(() => {
    disposed = true;
    for (const frame of scheduledFrames) cancelAnimationFrame(frame);
    scheduledFrames.clear();
  });
  return (
    <ConfirmationProvider confirm={confirmation.confirm}>
      <WorkspaceProvider value={controller}>
        <confirmation.View />
        <main
          class="app-shell"
          aria-label="VideoCutlist segment selection"
          style={`--media-panel-width:${mediaWidth()}px;--segments-panel-width:${segmentsWidth()}px;--media-handle-width:${mediaOpen() ? 12 : 0}px;--segments-handle-width:${tasksOpen() ? 12 : 0}px`}
          onKeyDown={(event) => {
            if (
              narrowViewport() &&
              event.key === "Escape" &&
              !event.defaultPrevented &&
              !event.target.closest(".modal, dialog, [role='menu']") &&
              (mediaOpen() || tasksOpen())
            ) {
              event.preventDefault();
              closeOpenDrawer();
            }
          }}
        >
          <div class="workspace-notices">
            <RecoveryNotice />
            <ProjectConflictNotice />
            <Show when={projectSaveState() === "failed" && !controller.projects.saveConflict()}>
              <div
                class="alert alert-error flex flex-wrap items-center justify-between gap-2 [&>span]:min-w-0 [&>span]:wrap-anywhere"
                role="alert"
              >
                <span>{controller.projects.saveError()}</span>
                <button
                  class="btn btn-ghost btn-xs"
                  type="button"
                  onClick={() => void controller.projects.retrySave()}
                >
                  Retry save
                </button>
              </div>
            </Show>
          </div>
          <Show when={projectToolsOpen()}>
            <ProjectDialog
              onClose={() => setProjectToolsOpen(false)}
              onCloseAutoFocus={() => projectMenuTrigger?.focus()}
            />
          </Show>
          <Dialog
            open={controller.editor.shortcutHelpOpen()}
            onOpenChange={controller.editor.setShortcutHelpOpen}
          >
            <Dialog.Portal>
              <div class="modal modal-open">
                <Dialog.Overlay class="modal-backdrop" />
                <Dialog.Content
                  aria-modal="true"
                  class="modal-box"
                  onOpenAutoFocus={() => {
                    shortcutReturnFocus ??=
                      document.activeElement instanceof HTMLElement
                        ? document.activeElement
                        : undefined;
                  }}
                  onCloseAutoFocus={() => {
                    shortcutReturnFocus?.focus();
                    shortcutReturnFocus = undefined;
                  }}
                >
                  <Dialog.Title id="shortcut-help-heading" class="text-lg font-bold">
                    Keyboard shortcuts
                  </Dialog.Title>
                  <p class="shortcut-help">
                    Outside text fields and dialogs; focused controls take priority.
                  </p>
                  <div
                    class="grid grid-cols-1 gap-3 sm:grid-cols-2"
                    aria-label="Keyboard shortcut reference"
                  >
                    <section>
                      <strong>Playback</strong>
                      <ul class="text-sm">
                        <li>Space: play / pause · , / .: preview step</li>
                        <li>← / →: seek 1 second when no boundary is selected</li>
                        <li>
                          P / L: play / loop active cut · R: preview cuts in order on the timeline
                        </li>
                      </ul>
                    </section>
                    <section>
                      <strong>Editing</strong>
                      <ul class="text-sm">
                        <li>I / O: mark In / Out · C: new draft · B: split</li>
                        <li>← / →: nudge selected boundary 100 ms</li>
                        <li>Delete / Backspace: remove active cut</li>
                        <li>Ctrl/Cmd+Z: undo · Ctrl/Cmd+Y: redo · E: create clips</li>
                        <li>Esc: deselect cut or clear incomplete marks</li>
                      </ul>
                    </section>
                    <section>
                      <strong>Detection</strong>
                      <ul class="text-sm">
                        <li>When focus is in the candidate list:</li>
                        <li>A / Y / Enter on a candidate row: accept</li>
                        <li>R / X / N / Delete / Backspace: dismiss</li>
                      </ul>
                    </section>
                    <section>
                      <strong>Panels</strong>
                      <ul class="text-sm">
                        <li>When a panel separator is focused:</li>
                        <li>← / →: resize 16 px · Home / R: reset width</li>
                        <li>Shift+/: keyboard help</li>
                      </ul>
                    </section>
                  </div>
                  <div class="modal-action">
                    <Dialog.CloseButton class="btn btn-primary" aria-label="Close">
                      Close
                    </Dialog.CloseButton>
                  </div>
                </Dialog.Content>
              </div>
            </Dialog.Portal>
          </Dialog>
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
            aria-hidden={!mediaOpen() || settingsOpen()}
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
                      ? controller.projects.saveError() || "Save failed. Try again."
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
                  class="btn btn-ghost btn-sm btn-square min-h-8 min-w-8"
                  type="button"
                  title={projectSaveState() === "failed" ? "Retry save" : "Save project"}
                  aria-label="Save project from project header"
                  disabled={projectSaveState() === "saving"}
                  onClick={() => void controller.projects.saveProject()}
                >
                  <Save size={16} aria-hidden="true" />
                </button>
                <button
                  class="btn btn-ghost btn-sm btn-square min-h-8 min-w-8"
                  type="button"
                  title={settingsOpen() ? "Back to editor" : "Settings"}
                  aria-label={settingsOpen() ? "Back to editor" : "Settings"}
                  onClick={toggleSettings}
                >
                  <Settings size={16} aria-hidden="true" />
                </button>
                <DropdownMenu modal={false} placement="bottom-end">
                  <DropdownMenu.Trigger
                    ref={(element) => (projectMenuTrigger = element)}
                    class="btn btn-ghost btn-sm btn-square min-h-8 min-w-8"
                    title="Project menu"
                    aria-label="Project menu"
                  >
                    <Ellipsis size={17} aria-hidden="true" />
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal>
                    <DropdownMenu.Content
                      as="ul"
                      class="menu menu-sm z-70 max-h-[min(70dvh,540px)] w-60 overflow-y-auto rounded-box bg-base-200 p-2 shadow-lg"
                      onCloseAutoFocus={(event) => {
                        if (projectToolsOpen() || controller.editor.shortcutHelpOpen())
                          event.preventDefault();
                      }}
                    >
                      <li>
                        <DropdownMenu.Item
                          as="button"
                          class="data-highlighted:bg-base-300"
                          onSelect={async () => {
                            const identity = controller.server.registry.get(
                              controller.workspaceIdentity,
                            );
                            const accepted =
                              !controller.dirty() || (await confirmation.confirm(discardChanges));
                            if (
                              identity ===
                              controller.server.registry.get(controller.workspaceIdentity)
                            )
                              controller.projects.newProject(accepted);
                          }}
                        >
                          New project
                        </DropdownMenu.Item>
                      </li>
                      <li>
                        <DropdownMenu.Item
                          as="button"
                          class="data-highlighted:bg-base-300"
                          onSelect={loadProjectFromMenu}
                        >
                          <FolderOpen size={15} aria-hidden="true" /> Load project
                        </DropdownMenu.Item>
                      </li>
                      <li>
                        <DropdownMenu.Item
                          as="button"
                          class="data-highlighted:bg-base-300"
                          onSelect={() => setProjectToolsOpen(true)}
                        >
                          <FolderOpen size={15} aria-hidden="true" /> Project tools
                        </DropdownMenu.Item>
                      </li>
                      <li>
                        <DropdownMenu.Item
                          as="button"
                          class="data-highlighted:bg-base-300"
                          onSelect={openHelp}
                        >
                          <CircleHelp size={15} aria-hidden="true" /> Keyboard help
                        </DropdownMenu.Item>
                      </li>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu>
              </div>
            </header>
            <LibraryView />
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
          <EditorView
            mediaOpen={mediaOpen()}
            tasksOpen={tasksOpen()}
            openMediaPanel={() => (mediaOpen() ? closeMediaPanel() : openMediaPanel())}
            openTaskPanel={() => (tasksOpen() ? closeTaskPanel() : openTaskPanel(activeTask()))}
            onChooseMedia={() => {
              openMediaPanel(false);
              scheduleFrame(() => {
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
          <Tabs
            as="aside"
            value={activeTask()}
            onChange={(value) => {
              if (value === "cuts" || value === "detection" || value === "export")
                selectTask(value);
            }}
            id="segments-panel"
            class="task-panel"
            classList={{
              "is-collapsed": !tasksOpen(),
              "drawer-open": narrowViewport() && tasksOpen(),
            }}
            aria-label="Segments and workspace tasks"
            aria-hidden={!tasksOpen() || settingsOpen()}
            role={narrowViewport() ? "dialog" : undefined}
            aria-modal={narrowViewport() ? "true" : undefined}
          >
            <Tabs.List class="tabs mb-4 grid grid-cols-3 gap-0.5" aria-label="Workspace tasks">
              <Tabs.Trigger
                id="cuts-tab"
                value="cuts"
                class="tab min-h-10 min-w-0 px-2 text-sm aria-selected:rounded-md aria-selected:bg-primary aria-selected:font-bold aria-selected:text-primary-content"
              >
                Cuts
              </Tabs.Trigger>
              <Tabs.Trigger
                id="detection-tab"
                value="detection"
                class="tab min-h-10 min-w-0 px-2 text-sm aria-selected:rounded-md aria-selected:bg-primary aria-selected:font-bold aria-selected:text-primary-content"
                disabled={!selected() || !controller.activeItemId()}
              >
                Auto-detect
              </Tabs.Trigger>
              <Tabs.Trigger
                id="export-tab"
                value="export"
                class="tab min-h-10 min-w-0 px-2 text-sm aria-selected:rounded-md aria-selected:bg-primary aria-selected:font-bold aria-selected:text-primary-content"
              >
                Export
              </Tabs.Trigger>
            </Tabs.List>
            <Tabs.Content
              id="cuts-tabpanel"
              value="cuts"
              forceMount
              hidden={activeTask() !== "cuts"}
            >
              <CutsView />
            </Tabs.Content>
            <Tabs.Content
              id="export-tabpanel"
              value="export"
              forceMount
              hidden={activeTask() !== "export"}
            >
              <ExportView />
            </Tabs.Content>
            <Tabs.Content
              id="detection-tabpanel"
              value="detection"
              forceMount
              hidden={activeTask() !== "detection"}
            >
              <DetectionView />
            </Tabs.Content>
            <details class="queue-footer mt-4 border-t border-base-300 pt-3">
              <summary class="cursor-pointer text-sm">
                Queue <span class="badge badge-sm">{controller.export.batches().length}</span>
              </summary>
              <QueueView />
            </details>
          </Tabs>
          <Show when={settingsOpen()}>
            <SettingsView onClose={() => setSettingsOpen(false)} />
          </Show>
        </main>
      </WorkspaceProvider>
    </ConfirmationProvider>
  );
}
