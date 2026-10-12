import type * as EffectApiTypes from "../generated/effect-api";
import { RegistryContext, useAtomValue } from "@effect/atom-solid";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { createEffect, onCleanup, useContext } from "solid-js";
import { createApiClient, resolveBrowserConfiguration } from "../api";
import { createPreviewController } from "../features/preview/controller";
import {
  createProjectItem,
  moveProjectItem,
  type EditableProjectItem,
} from "../features/projects/model";
import { createDetectionController } from "../features/detection/controller";
import { createSettingsController } from "../features/settings/controller";
import { createLibraryController } from "../features/media/controller";
import { createProjectsController } from "../features/projects/controller";
import { createExportController } from "../features/export/controller";
import { createEditorController } from "../features/editor/controller";
import { createTimelineHistory, type TimelineHistory } from "../features/editor/timeline";
import { createServerState, useServerAtom } from "./server";
import { createWorkspaceIdentity } from "./workspaceIdentity";
type Media = EffectApiTypes.Media;

export function createWorkspaceController() {
  const configuration = resolveBrowserConfiguration();
  const api = createApiClient(configuration);
  const registry = useContext(RegistryContext);
  const server = createServerState(api, registry, configuration);
  const shortcutHelpOpen = useAtomValue(
    () => server.workspacePanelState,
    (state) => state.shortcutHelpOpen,
  );
  const setShortcutHelpOpen = (open: boolean) =>
    registry.update(server.workspacePanelState, (state) => ({ ...state, shortcutHelpOpen: open }));
  onCleanup(() => {
    projectsFeature.dispose();
    clearDetectionContext();
  });
  const identity = createWorkspaceIdentity(server);
  const workspaceState = useAtomValue(() => identity.state);
  const projectId = () => workspaceState().projectId;
  const projectName = () => workspaceState().projectName;
  const revision = () => workspaceState().revision;
  const dirty = () => workspaceState().dirty;
  const status = () => workspaceState().status;
  const activeItemId = () => workspaceState().activeItemId;
  const editorVersion = () => workspaceState().editVersion;
  const editorContext = useAtomValue(() => identity.context);
  const setStatus: import("solid-js").Setter<string> = (input) => {
    const value = typeof input === "function" ? input(status()) : input;
    identity.setStatus(value);
    return value;
  };
  const setDirty: import("solid-js").Setter<boolean> = (input) => {
    const value = typeof input === "function" ? input(dirty()) : input;
    identity.setDirty(value);
    return value;
  };
  const setRevision: import("solid-js").Setter<number> = (input) => {
    const value = typeof input === "function" ? input(revision()) : input;
    identity.setRevision(value);
    return value;
  };
  const mediaRevision = useAtomValue(() => server.mediaRevision);
  const noMedia = Atom.make(AsyncResult.initial<Media, Error>());
  const selectedMediaAtom = () => {
    const id = workspaceState().selectedMediaId;
    return id ? server.media(id, mediaRevision()) : noMedia;
  };
  const selectedMedia = useServerAtom(selectedMediaAtom);
  const selected = () => {
    const id = workspaceState().selectedMediaId;
    if (!id) return;
    return selectedMedia.value()?.id === id
      ? selectedMedia.value()
      : visibleMedia().find((item) => item.id === id);
  };
  const settingsFeature = createSettingsController(api, server);
  const { settings } = settingsFeature;
  const projectItemsAtom = Atom.keepAlive(Atom.make<EditableProjectItem[]>([]));
  const observedProjectItems = useAtomValue(() => projectItemsAtom);
  const projectItems = () => {
    observedProjectItems();
    return registry.get(projectItemsAtom);
  };
  const previewTimeline = Atom.keepAlive(
    Atom.make(createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 })),
  );
  // The editor writes the active item's history directly; there is no snapshot to synchronize.
  const activeTimeline = Atom.writable<TimelineHistory, TimelineHistory>(
    (get) => {
      const id = get(identity.state).activeItemId;
      return get(projectItemsAtom).find((item) => item.id === id)?.timeline ?? get(previewTimeline);
    },
    (ctx, timeline) => {
      const id = ctx.get(identity.state).activeItemId;
      const items = ctx.get(projectItemsAtom);
      if (items.some((item) => item.id === id))
        ctx.set(
          projectItemsAtom,
          items.map((item) => (item.id === id ? { ...item, timeline } : item)),
        );
      else ctx.set(previewTimeline, timeline);
    },
  );

  const setProjectItems: import("solid-js").Setter<EditableProjectItem[]> = (
    input: EditableProjectItem[] | ((items: EditableProjectItem[]) => EditableProjectItem[]),
  ) => {
    const items = typeof input === "function" ? input(registry.get(projectItemsAtom)) : input;
    registry.set(projectItemsAtom, items);
    return items;
  };
  const previewMuted = Atom.keepAlive(Atom.make(settings().muted));
  const mutedAtom = Atom.writable<boolean, boolean>(
    (get) => {
      const id = get(identity.state).activeItemId;
      return get(projectItemsAtom).find((item) => item.id === id)?.muted ?? get(previewMuted);
    },
    (ctx, muted) => {
      const id = ctx.get(identity.state).activeItemId;
      const items = ctx.get(projectItemsAtom);
      if (items.some((item) => item.id === id))
        ctx.set(
          projectItemsAtom,
          items.map((item) => (item.id === id ? { ...item, muted } : item)),
        );
      else ctx.set(previewMuted, muted);
    },
  );
  const muted = useAtomValue(() => mutedAtom);
  const setMuted: import("solid-js").Setter<boolean> = (
    input: boolean | ((value: boolean) => boolean),
  ) => {
    const value = typeof input === "function" ? input(registry.get(mutedAtom)) : input;
    registry.set(mutedAtom, value);
    return value;
  };
  const markDirty = () => {
    identity.markDirty();
    projectsFeature.scheduleAutosave();
  };
  const selectActiveExportItem = () => {
    const id = activeItemId();
    if (!id) return;
    setSelectedExportItems((ids) => (ids.includes(id) ? ids : [...ids, id]));
  };
  const editorFeature = createEditorController({
    server,
    timelineAtom: activeTimeline,
    selected,
    segmentIdentityScope: activeItemId,
    setStatus,
    markDirty,
    setPreviewCenterMs: (ms) => initializedPreviewFeature.setPreviewCenterMs(ms),
    watchedPosition: () => initializedPreviewFeature.watchedPosition(),
    togglePlayback: () => initializedPreviewFeature.togglePlayback(),
    playActiveSegment: (loop) => initializedPreviewFeature.playActiveSegment(loop),
    playOrderedSegments: () => initializedPreviewFeature.playOrderedSegments(),
    pausePlayback: () => initializedPreviewFeature.pausePlayback(),
    createClips: () => exportFeature.exportProject(),
    shortcutHelpOpen,
    setShortcutHelpOpen,
    onSegmentCommitted: () => {
      addMediaToProject();
      selectActiveExportItem();
    },
  });
  const {
    timeline,
    replaceTimeline,
    activeSegment,
    present,
    playheadMs,
    updateTimeline,
    updatePlaybackPosition,
  } = editorFeature;
  const exportFeature = createExportController({
    server,
    itemsAtom: projectItemsAtom,
    optionsContext: identity.state,
    preflightContext: identity.state,
    selected,
    projectId,
    revision,
    dirty,
    editorVersion,
    status,
    editableItems: () => editableItems(),
    saveProject: () => projectsFeature.saveProjectEffect(),
    markDirty: () => markDirty(),
    saveSettings: settingsFeature.saveSettings,
  });
  const {
    setSelectedExportItems,
    setExportMode,
    setExportSelection,
    setCutStrategy,
    setExportContainer,
    setStreamIndexes,
    setDestinationId,
    setFilenameTemplate,
  } = exportFeature;
  const editableItems = projectItems;
  const activateItem = (requested: EditableProjectItem) => {
    if (!projectItems().some((item) => item.id === requested.id)) return;
    editorFeature.prepareMediaSwitch();
    const items = editableItems();
    const item = items.find((item) => item.id === requested.id)!;
    identity.updateContext({ activeItemId: item.id, selectedMediaId: item.media.id });
    replaceTimeline(item.timeline);
    setPreviewCenterMs(item.timeline.present.playheadMs);
    setMuted(item.muted);
    exportFeature.resetContainerChoice();
    setDiagnostics();
  };
  const libraryFeature = createLibraryController(server, identity.state);
  const libraryView = useAtomValue(() => libraryFeature.view);
  const media = () => libraryView().media;
  const refreshMedia = libraryFeature.refreshMedia;
  const projectMedia = Atom.family((key: string) => {
    let identity: [string, string, number];
    try {
      identity = JSON.parse(key) as [string, string, number];
    } catch (cause) {
      throw new Error("Invalid project media observation identity.", { cause });
    }
    const [, id, revision] = identity;
    return Atom.setIdleTTL(
      Atom.make((get) => {
        const source = server.media(id, revision);
        get.addFinalizer(registry.mount(source));
        get.addFinalizer(registry.subscribe(source, (value) => get.setSelf(value)));
        return get.once(source);
      }),
      0,
    );
  });
  const projectMediaProjection = Atom.setIdleTTL(
    Atom.make((get) => {
      // Project replacement and metadata refresh release the previous observation graph.
      const projectId = get(identity.state).projectId;
      const revision = get(server.mediaRevision);
      return get(projectItemsAtom).map((item) => {
        const result = get(projectMedia(JSON.stringify([projectId, item.media.id, revision])));
        return AsyncResult.isSuccess(result) ? result.value : item.media;
      });
    }),
    0,
  );
  const projectedMedia = useAtomValue(() => projectMediaProjection);
  const visibleMedia = () => {
    const items: Media[] = [];
    const ids = new Set<string>();
    for (const item of [...media(), ...projectedMedia()]) {
      if (ids.has(item.id)) continue;
      ids.add(item.id);
      items.push(item);
    }
    return items;
  };
  const previewSelectedAtom = Atom.make((get) => {
    const id = get(identity.state).selectedMediaId;
    if (!id) return undefined;
    const result = get(server.media(id, get(server.mediaRevision)));
    const value = AsyncResult.isSuccess(result) ? result.value : undefined;
    return value?.id === id
      ? value
      : [...get(libraryFeature.view).media, ...get(projectMediaProjection)].find(
          (item) => item.id === id,
        );
  });
  const initializedPreviewFeature = createPreviewController(api, {
    server,
    selectedAtom: previewSelectedAtom,
    selected,
    playheadMs,
    activeSegment,
    segments: () => present().segments,
    preferences: settings,
    savePreferences: settingsFeature.saveSettings,
    updatePlaybackPosition,
  });
  const { setPreviewCenterMs, setDiagnostics } = initializedPreviewFeature;
  const chooseMedia = (item: Media) => {
    clearDetectionContext();
    const existing = projectItems().find((entry) => entry.media.id === item.id);
    if (existing) {
      activateItem(existing);
      setStatus(`Activated ${item.name} in the project.`);
      return;
    }
    editorFeature.prepareMediaSwitch();
    identity.updateContext({ activeItemId: undefined, selectedMediaId: item.id });
    replaceTimeline(createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 }));
    setPreviewCenterMs(0);
    setMuted(settings().muted);
    setExportMode("separate");
    setExportSelection("segments");
    setStreamIndexes([]);
    setCutStrategy(settings().cutStrategy);
    setExportContainer("mkv");
    setDestinationId(settings().lastDestinationId ?? "download");
    setFilenameTemplate(settings().filenameTemplate);
    setDiagnostics();
    setStatus(`Previewing ${item.name}. The first valid cut adds it to the project.`);
  };
  const addMediaToProject = () => {
    const item = selected();
    if (!item) return;
    const items = editableItems();
    const existing = items.find((entry) => entry.media.id === item.id);
    if (existing && existing.id === activeItemId()) return;
    if (existing) {
      activateItem(existing);
      setStatus(`Activated ${item.name} in the project.`);
      return;
    }
    const added = {
      ...createProjectItem(item, settings().lastDestinationId),
      timeline: timeline(),
      muted: muted(),
      exportOptions: { ...registry.get(exportFeature.optionsAtom) },
    };
    setProjectItems([...items, added]);
    identity.updateContext({ activeItemId: added.id });
    setSelectedExportItems((ids) => (ids.includes(added.id) ? ids : [...ids, added.id]));
    markDirty();
    setStatus(`Added ${item.name} to the project.`);
  };
  const reorderProjectItem = (id: string, direction: -1 | 1) => {
    const items = editableItems();
    const reordered = moveProjectItem(items, id, direction);
    if (reordered === items) return;
    setProjectItems(reordered);
    markDirty();
  };
  const removeProjectItem = (id: string, confirmed: boolean) => {
    if (!confirmed || !projectItems().some((item) => item.id === id)) return;
    const remaining = editableItems().filter((item) => item.id !== id);
    setProjectItems(remaining);
    setSelectedExportItems((ids) => ids.filter((item) => item !== id));
    if (activeItemId() === id) {
      const next = remaining[0];
      if (next) activateItem(next);
      else {
        editorFeature.prepareMediaSwitch();
        identity.updateContext({ activeItemId: undefined, selectedMediaId: undefined });
        replaceTimeline(createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 }));
      }
    }
    markDirty();
  };
  createEffect(() => {
    const isDirty = dirty();
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    onCleanup(() => window.removeEventListener("beforeunload", handler));
  });
  const detectionReviewContext = Atom.make((get) => {
    const context = get(identity.state);
    return {
      projectId: context.projectId,
      activeItemId: context.activeItemId,
      selected: get(previewSelectedAtom),
      revision: context.revision,
      editorVersion: context.editVersion,
      saveConflict: get(projectsFeature.conflictAtom),
    };
  });
  const detectionFeature = createDetectionController(server, {
    reviewContext: detectionReviewContext,
    selected,
    activeItemId,
    projectId,
    revision,
    dirty,
    editorVersion,
    saveConflict: () => projectsFeature.saveConflict(),
    segments: () => present().segments,
    saveProject: () => projectsFeature.saveProjectEffect(),
    updateSegments: (segments) => updateTimeline({ segments }),
  });
  const { clearDetectionContext } = detectionFeature;
  const projectsFeature = createProjectsController({
    server,
    activeItemId,
    selected,
    projectId,
    projectName,
    revision,
    setRevision,
    dirty,
    setDirty,
    projectItems,
    setProjectItems,
    setSelectedExportItems,
    replaceContext: ({ selected: source, ...context }) =>
      identity.updateContext({
        ...context,
        activeItemId: context.activeItemId,
        selectedMediaId: source?.id,
      }),
    replaceTimeline,
    setPreviewCenterMs,
    settings,
    setMuted,
    editableItems,
    editorVersion,
    contextKey: editorContext,
    clearDetectionContext,
    setDiagnostics,
    setStatus,
  });
  return {
    server,
    library: libraryFeature,
    editor: editorFeature,
    preview: initializedPreviewFeature,
    settings: settingsFeature,
    detection: detectionFeature,
    projects: projectsFeature,
    export: exportFeature,
    visibleMedia,
    selected,
    refreshMedia,
    status,
    setStatus,
    metadataError: () => selectedMedia.error()?.message,
    metadataLoading: () => Boolean(selected()) && selectedMedia.waiting(),
    retryMetadata: () => server.registry.refresh(selectedMediaAtom()),
    muted,
    setMuted,
    projectId,
    projectName,
    editProjectName: (name: string) => {
      if (name === projectName()) return;
      identity.editName(name);
      projectsFeature.scheduleAutosave();
    },
    editorVersion,
    workspaceIdentity: identity.state,
    revision,
    setRevision,
    dirty,
    setDirty,
    projectItems,
    activeItemId,
    editorContext,
    recent: projectsFeature.recent,
    visibleTimelineRange: initializedPreviewFeature.visibleRange,
    setVisibleTimelineRange: initializedPreviewFeature.setVisibleRange,
    editableItems,
    activateItem,
    markDirty,
    chooseMedia,
    addMediaToProject,
    reorderProjectItem,
    removeProjectItem,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
