import { createEffect, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import {
  PANEL_PREFERENCES_KEY,
  clampPanelPreferences,
  defaultPanelPreferences,
  parsePanelPreferences,
  serializePanelPreferences,
} from "./panelPreferences";

export const workspaceTaskTabs = ["cuts", "project", "export", "detection"] as const;
export type WorkspaceTask = (typeof workspaceTaskTabs)[number];
export type ResizablePanel = "media" | "segments";

export function createWorkspacePanelController(deps: {
  selected: Accessor<unknown>;
  activeItem: Accessor<unknown>;
  dirty: Accessor<boolean>;
  segmentCount: Accessor<number>;
  setSettingsOpen: Setter<boolean>;
}) {
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
  const [activeTask, setActiveTask] = createSignal<WorkspaceTask>("project");
  let hadSelectedMedia = false;
  let hadActiveItem = false;
  let previousSegmentCount = 0;
  let resizeState: { panel: ResizablePanel; startX: number; startWidth: number } | undefined;

  const focusPanel = (panel: ResizablePanel) => {
    requestAnimationFrame(() => {
      const target = panel === "media" ? "media-heading" : `${activeTask()}-tab`;
      document.getElementById(target)?.focus();
    });
  };
  const restoreTriggerFocus = (panel: ResizablePanel) => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLButtonElement>(
          `[aria-controls="${panel === "media" ? "media-panel" : "segments-panel"}"]`,
        )
        ?.focus();
    });
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
  const openTaskPanel = (task: WorkspaceTask, focus = true) => {
    deps.setSettingsOpen(false);
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
  const finishPanelResize = () => {
    resizeState = undefined;
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
  const moveTask = (current: WorkspaceTask, direction: number) => {
    const start = workspaceTaskTabs.indexOf(current);
    let nextTask: WorkspaceTask | undefined;
    for (let offset = 1; offset <= workspaceTaskTabs.length; offset += 1) {
      const candidate =
        workspaceTaskTabs[
          (start + direction * offset + workspaceTaskTabs.length) % workspaceTaskTabs.length
        ];
      if (candidate !== "detection" || deps.selected()) {
        nextTask = candidate;
        break;
      }
    }
    if (nextTask) {
      setActiveTask(nextTask);
      document.getElementById(`${nextTask}-tab`)?.focus();
    }
  };

  createEffect(() => {
    const hasSelectedMedia = Boolean(deps.selected());
    if (hasSelectedMedia && !hadSelectedMedia)
      queueMicrotask(() => {
        if (narrowViewport()) {
          closeMediaPanel(false);
          requestAnimationFrame(() => document.getElementById("timeline-heading")?.focus());
        }
        if (deps.dirty() || !deps.activeItem()) setActiveTask("cuts");
      });
    hadSelectedMedia = hasSelectedMedia;
  });
  createEffect(() => {
    const hasActiveItem = Boolean(deps.activeItem());
    if (hasActiveItem && !hadActiveItem && narrowViewport())
      queueMicrotask(() => openTaskPanel("cuts", false));
    hadActiveItem = hasActiveItem;
  });
  createEffect(() => {
    const segmentCount = deps.segmentCount();
    if (segmentCount > previousSegmentCount && narrowViewport() && !tasksOpen())
      queueMicrotask(() => openTaskPanel("cuts", false));
    previousSegmentCount = segmentCount;
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

  return {
    activeTask,
    setActiveTask,
    narrowViewport,
    mediaWidth,
    segmentsWidth,
    mediaOpen,
    tasksOpen,
    openMediaPanel,
    closeMediaPanel,
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
