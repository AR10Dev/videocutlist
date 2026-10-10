import { useAtomValue } from "@effect/atom-solid";
import { Effect } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createEffect, createSignal, onCleanup, type Accessor } from "solid-js";
import type { ServerState } from "./server";
import {
  clampPanelPreferences,
  defaultPanelPreferences,
  type PanelPreferences,
} from "./panelPreferences";
import { workspaceTaskTabs, type WorkspaceTask } from "./panelState";

export { workspaceTaskTabs } from "./panelState";
export type { WorkspaceTask } from "./panelState";
export type ResizablePanel = "media" | "segments";

type PanelAction =
  | { type: "initialize"; narrow: boolean; viewportWidth: number }
  | { type: "viewport"; narrow: boolean; viewportWidth: number }
  | { type: "media"; open: boolean; persist: boolean; narrow: boolean }
  | { type: "tasks"; open: boolean; narrow: boolean; task?: WorkspaceTask }
  | { type: "task"; task: WorkspaceTask }
  | { type: "project-tools"; open: boolean }
  | { type: "resize"; panel: ResizablePanel; width: number; viewportWidth: number }
  | { type: "nudge"; panel: ResizablePanel; delta: number; viewportWidth: number }
  | { type: "reset-width"; panel: ResizablePanel; viewportWidth: number };

function resizePreferences(
  current: PanelPreferences,
  panel: ResizablePanel,
  width: number,
  viewportWidth: number,
): PanelPreferences {
  return clampPanelPreferences(
    {
      ...current,
      ...(panel === "media" ? { mediaWidth: width } : { segmentsWidth: width }),
    },
    viewportWidth,
  );
}

export function createWorkspacePanelController(deps: {
  server: ServerState;
  selected: Accessor<unknown>;
  activeItem: Accessor<unknown>;
  dirty: Accessor<boolean>;
  segmentCount: Accessor<number>;
  closeSettings: (open: boolean) => unknown;
}) {
  const { registry, runtime, panelPreferences, workspacePanelState } = deps.server;
  const initialNarrowViewport = window.innerWidth < 1050;
  registry.update(workspacePanelState, (state) => ({
    ...state,
    mediaOpen: true,
    tasksOpen: !initialNarrowViewport,
  }));
  const preferences = useAtomValue(() => panelPreferences.value);
  const panelState = useAtomValue(() => workspacePanelState);
  const [narrowViewport, setNarrowViewport] = createSignal(initialNarrowViewport);
  let disposed = false;
  let resizeState: { panel: ResizablePanel; startX: number; startWidth: number } | undefined;
  let pointerCapture: { target: HTMLElement; pointerId: number } | undefined;
  const scheduledFrames = new Set<number>();

  const scheduleFrame = (callback: () => void) => {
    if (disposed) return;
    const frame = requestAnimationFrame(() => {
      scheduledFrames.delete(frame);
      if (!disposed) callback();
    });
    scheduledFrames.add(frame);
  };
  const scheduleMicrotask = (callback: () => void) => {
    if (disposed) return;
    queueMicrotask(() => {
      if (!disposed) callback();
    });
  };
  const activeTask = () => panelState().activeTask;
  const mediaOpen = () => panelState().mediaOpen;
  const tasksOpen = () => panelState().tasksOpen;
  const mediaWidth = () =>
    narrowViewport()
      ? preferences().mediaWidth
      : clampPanelPreferences(preferences(), window.innerWidth).mediaWidth;
  const segmentsWidth = () =>
    narrowViewport()
      ? preferences().segmentsWidth
      : clampPanelPreferences(preferences(), window.innerWidth).segmentsWidth;

  const panelCommand = runtime.fn(
    ({ action, after }: { action: PanelAction; after?: () => void }) =>
      Effect.gen(function* () {
        if (action.type !== "task" && action.type !== "project-tools")
          yield* AtomRegistry.getResult(registry, panelPreferences.initialize, {
            suspendOnWaiting: true,
          });
        yield* Effect.sync(() => {
          const current = registry.get(workspacePanelState);
          const currentPreferences = registry.get(panelPreferences.value);
          switch (action.type) {
            case "initialize": {
              const restored = {
                ...currentPreferences,
                mediaCollapsed: false,
                segmentsCollapsed: false,
              };
              registry.set(
                panelPreferences.value,
                action.narrow ? restored : clampPanelPreferences(restored, action.viewportWidth),
              );
              break;
            }
            case "viewport":
              if (action.narrow && current.mediaOpen && current.tasksOpen)
                registry.set(workspacePanelState, { ...current, tasksOpen: false });
              if (!action.narrow) {
                registry.set(workspacePanelState, {
                  ...current,
                  mediaOpen: !currentPreferences.mediaCollapsed,
                  tasksOpen: !currentPreferences.segmentsCollapsed,
                });
              }
              if (!action.narrow) {
                const clamped = clampPanelPreferences(currentPreferences, action.viewportWidth);
                if (
                  clamped.mediaWidth !== currentPreferences.mediaWidth ||
                  clamped.segmentsWidth !== currentPreferences.segmentsWidth
                )
                  registry.set(panelPreferences.value, clamped);
              }
              break;
            case "media": {
              registry.set(workspacePanelState, {
                ...current,
                mediaOpen: action.open,
                ...(action.open && action.narrow ? { tasksOpen: false } : {}),
              });
              if (action.persist) {
                const next = { ...currentPreferences, mediaCollapsed: !action.open };
                registry.set(
                  panelPreferences.value,
                  action.narrow ? next : clampPanelPreferences(next, window.innerWidth),
                );
              }
              break;
            }
            case "tasks": {
              registry.set(workspacePanelState, {
                ...current,
                ...(action.task ? { activeTask: action.task } : {}),
                tasksOpen: action.open,
                ...(action.open && action.narrow ? { mediaOpen: false } : {}),
                ...(action.open ? { settingsOpen: false } : {}),
              });
              const next = { ...currentPreferences, segmentsCollapsed: !action.open };
              registry.set(
                panelPreferences.value,
                action.narrow ? next : clampPanelPreferences(next, window.innerWidth),
              );
              break;
            }
            case "task":
              registry.update(workspacePanelState, (state) => ({
                ...state,
                activeTask: action.task,
              }));
              break;
            case "project-tools":
              registry.update(workspacePanelState, (state) => ({
                ...state,
                projectToolsOpen: action.open,
              }));
              break;
            case "resize":
              registry.set(
                panelPreferences.value,
                resizePreferences(
                  currentPreferences,
                  action.panel,
                  action.width,
                  action.viewportWidth,
                ),
              );
              break;
            case "nudge": {
              const width =
                action.panel === "media"
                  ? currentPreferences.mediaWidth
                  : currentPreferences.segmentsWidth;
              registry.set(
                panelPreferences.value,
                resizePreferences(
                  currentPreferences,
                  action.panel,
                  width + action.delta,
                  action.viewportWidth,
                ),
              );
              break;
            }
            case "reset-width": {
              const defaults = defaultPanelPreferences();
              registry.set(
                panelPreferences.value,
                resizePreferences(
                  currentPreferences,
                  action.panel,
                  action.panel === "media" ? defaults.mediaWidth : defaults.segmentsWidth,
                  action.viewportWidth,
                ),
              );
              break;
            }
          }
        });
        if (!disposed) yield* Effect.sync(() => after?.());
      }),
    { concurrent: true },
  );
  const releasePanel = registry.mount(panelCommand);
  onCleanup(() => {
    registry.set(panelCommand, Atom.Interrupt);
    releasePanel();
  });
  const dispatch = (action: PanelAction, after?: () => void) => {
    registry.set(panelCommand, { action, after });
  };

  const focusPanel = (panel: ResizablePanel) => {
    scheduleFrame(() => {
      if (panel === "media") {
        const target =
          document.querySelector<HTMLElement>("#media-panel .media-list button") ??
          document.querySelector<HTMLElement>("#media-panel .media-panel .panel-heading button");
        target?.focus();
        return;
      }
      document.getElementById(`${activeTask()}-tab`)?.focus();
    });
  };
  const restoreTriggerFocus = (panel: ResizablePanel) => {
    scheduleFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[aria-controls="${panel === "media" ? "media-panel" : "segments-panel"}"]`,
        )
        ?.focus();
    });
  };
  const openMediaPanel = (focus = true) => {
    void dispatch(
      { type: "media", open: true, persist: true, narrow: narrowViewport() },
      () => focus && focusPanel("media"),
    );
  };
  const closeMediaPanel = (restoreFocus = true) => {
    void dispatch(
      { type: "media", open: false, persist: true, narrow: narrowViewport() },
      () => restoreFocus && narrowViewport() && restoreTriggerFocus("media"),
    );
  };
  const hideMediaPanel = () => {
    void dispatch({ type: "media", open: false, persist: false, narrow: narrowViewport() });
  };
  const toggleMediaPanel = () => (mediaOpen() ? closeMediaPanel() : openMediaPanel());
  const openTaskPanel = (task: WorkspaceTask, focus = true) => {
    deps.closeSettings(false);
    void dispatch(
      { type: "tasks", open: true, task, narrow: narrowViewport() },
      () => focus && scheduleFrame(() => document.getElementById(`${task}-tab`)?.focus()),
    );
  };
  const closeTaskPanel = (restoreFocus = true) => {
    void dispatch(
      { type: "tasks", open: false, narrow: narrowViewport() },
      () => restoreFocus && narrowViewport() && restoreTriggerFocus("segments"),
    );
  };
  const selectTask = (task: WorkspaceTask) => {
    void dispatch({ type: "task", task });
  };
  const toggleTaskPanel = () => (tasksOpen() ? closeTaskPanel() : openTaskPanel(activeTask()));
  const closeOpenDrawer = () => {
    if (mediaOpen()) closeMediaPanel();
    else if (tasksOpen()) closeTaskPanel();
  };
  const resetPanelWidth = (panel: ResizablePanel) => {
    void dispatch({ type: "reset-width", panel, viewportWidth: window.innerWidth });
  };
  const updatePanelWidth = (panel: ResizablePanel, value: number) => {
    void dispatch({ type: "resize", panel, width: value, viewportWidth: window.innerWidth });
  };
  const finishPanelResize = () => {
    resizeState = undefined;
    const capture = pointerCapture;
    pointerCapture = undefined;
    if (capture?.target.hasPointerCapture(capture.pointerId)) {
      try {
        capture.target.releasePointerCapture(capture.pointerId);
      } catch {
        // The element may have been detached while the drag was active.
      }
    }
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
    void dispatch({ type: "nudge", panel, delta, viewportWidth: window.innerWidth });
  };
  const beginPanelResize = (panel: ResizablePanel, event: PointerEvent) => {
    if (narrowViewport()) return;
    event.preventDefault();
    resizeState = {
      panel,
      startX: event.clientX,
      startWidth: panel === "media" ? mediaWidth() : segmentsWidth(),
    };
    const target = event.currentTarget as HTMLElement;
    try {
      target.setPointerCapture(event.pointerId);
      pointerCapture = { target, pointerId: event.pointerId };
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
  const moveTask = (current: WorkspaceTask, direction: number) => {
    const start = workspaceTaskTabs.indexOf(current);
    let nextTask: WorkspaceTask | undefined;
    for (let offset = 1; offset <= workspaceTaskTabs.length; offset += 1) {
      const candidate =
        workspaceTaskTabs[
          (start + direction * offset + workspaceTaskTabs.length) % workspaceTaskTabs.length
        ];
      if (candidate !== "detection" || (deps.selected() && deps.activeItem())) {
        nextTask = candidate;
        break;
      }
    }
    if (nextTask) {
      void dispatch({ type: "task", task: nextTask }, () =>
        scheduleFrame(() => document.getElementById(`${nextTask}-tab`)?.focus()),
      );
    }
  };

  let hadSelectedMedia = false;
  let hadActiveItem = false;
  let previousSegmentCount = 0;
  void dispatch({
    type: "initialize",
    narrow: initialNarrowViewport,
    viewportWidth: window.innerWidth,
  });
  createEffect(() => {
    const hasSelectedMedia = Boolean(deps.selected());
    if (hasSelectedMedia && !hadSelectedMedia)
      scheduleMicrotask(() => {
        if (narrowViewport()) {
          closeMediaPanel(false);
          scheduleFrame(() => document.getElementById("timeline-heading")?.focus());
        }
        if (deps.dirty() || !deps.activeItem()) selectTask("cuts");
      });
    hadSelectedMedia = hasSelectedMedia;
  });
  createEffect(() => {
    const hasActiveItem = Boolean(deps.activeItem());
    if (hasActiveItem && !hadActiveItem && narrowViewport())
      scheduleMicrotask(() => openTaskPanel("cuts", false));
    hadActiveItem = hasActiveItem;
  });
  createEffect(() => {
    const segmentCount = deps.segmentCount();
    if (segmentCount > previousSegmentCount && narrowViewport() && !tasksOpen())
      scheduleMicrotask(() => openTaskPanel("cuts", false));
    previousSegmentCount = segmentCount;
  });
  createEffect(() => {
    const handleResize = () => {
      const nextNarrow = window.innerWidth < 1050;
      const wasNarrow = narrowViewport();
      setNarrowViewport(nextNarrow);
      if (nextNarrow !== wasNarrow)
        void dispatch({ type: "viewport", narrow: nextNarrow, viewportWidth: window.innerWidth });
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
  onCleanup(() => {
    disposed = true;
    finishPanelResize();
    for (const frame of scheduledFrames) cancelAnimationFrame(frame);
    scheduledFrames.clear();
  });

  return {
    activeTask,
    selectTask,
    narrowViewport,
    mediaWidth,
    segmentsWidth,
    mediaOpen,
    tasksOpen,
    projectToolsOpen: () => panelState().projectToolsOpen,
    setProjectToolsOpen: (open: boolean) => dispatch({ type: "project-tools", open }),
    openMediaPanel,
    closeMediaPanel,
    hideMediaPanel,
    toggleMediaPanel,
    openTaskPanel,
    closeTaskPanel,
    toggleTaskPanel,
    closeOpenDrawer,
    resetPanelWidth,
    resizePanelWithKeyboard,
    beginPanelResize,
    moveTask,
  };
}
