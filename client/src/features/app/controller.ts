import type * as EffectApiTypes from "../../generated/effect-api";
import { RegistryContext, useAtomValue } from "@effect/atom-solid";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { createEffect, createRoot, createSignal, onCleanup, useContext } from "solid-js";
import { createApiClient, resolveBrowserConfiguration } from "../../api";
import { createPreviewController } from "../preview/controller";
import { createProjectItem, moveProjectItem, type EditableProjectItem } from "../projects/model";
import { createDetectionController } from "../detection/controller";
import {
  newProjectId,
  recentProjects,
  recentProjectsKey,
  type RecentProject,
} from "../projects/lifecycle";
import { createSettingsController } from "../settings/controller";
import { createLibraryController } from "../media/controller";
import { createProjectsController } from "../projects/controller";
import { createExportController } from "../export/controller";
import { lastDestinationId } from "../export/destination";
import { createEditorController } from "../editor/controller";
import { createTimelineHistory } from "../editor/timeline";
import type { AssetViewport } from "../preview/assets";
import { createServerState, useServerAtom } from "./server";
type Media = EffectApiTypes.Media;

export function createWorkspaceController() {
  const configuration = resolveBrowserConfiguration();
  const api = createApiClient(configuration);
  const registry = useContext(RegistryContext);
  const server = createServerState(api, registry, configuration);
  onCleanup(() => {
    projectsFeature.dispose();
    clearDetectionContext();
    server.registry.dispose();
  });
  const [selected, setSelected] = createSignal<Media>();
  const [visibleTimelineRange, setVisibleTimelineRange] = createSignal<AssetViewport>({
    startMs: 0,
    endMs: 0,
  });
  let visibleRangeMediaId: string | undefined;
  createEffect(() => {
    const item = selected();
    if (item?.id === visibleRangeMediaId) return;
    visibleRangeMediaId = item?.id;
    setVisibleTimelineRange({ startMs: 0, endMs: item?.durationMs ?? 0 });
  });
  const [status, setStatus] = createSignal("Loading media…");
  const settingsFeature = createSettingsController(api, server);
  const {
    settings,
    setSettings,
    appearance,
    setAppearance,
    settingsOpen,
    setSettingsOpen,
    serverSettingsStatus,
    libraryRoots,
    settingsRevision,
    runtimeSettings,
    settingsPending,
    rescanPending,
    mcpSettings,
    mcpStatus,
    mcpLoadError,
    mcpLoading,
    loadMCPSettings,
    mcpPending,
    revealedMCPSecret,
    saveSettings,
    openSettings,
    saveRuntimeSettings,
    setMCPEnabled,
    createMCPCredential,
    approveExportProposal,
    revokeMCPCredential,
    rescanLibrary,
  } = settingsFeature;
  const [muted, setMuted] = createSignal(settings().muted);
  const [projectId, setProjectId] = createSignal(newProjectId());
  const [projectName, setProjectName] = createSignal("Untitled project");
  const [revision, setRevision] = createSignal(0);
  const [dirty, setDirty] = createSignal(false);
  const [projectItems, setProjectItems] = createSignal<EditableProjectItem[]>([]);
  const [activeItemId, setActiveItemId] = createSignal<string>();
  const [editorContextRevision, setEditorContextRevision] = createSignal(0);
  const advanceEditorContext = () => setEditorContextRevision((value) => value + 1);
  const editorContext = () => `${projectId()}::${selected()?.id ?? ""}::${editorContextRevision()}`;
  const [recent, setRecent] = createSignal<RecentProject[]>(
    (() => {
      try {
        return recentProjects(JSON.parse(localStorage.getItem(recentProjectsKey) ?? "[]"));
      } catch {
        return [];
      }
    })(),
  );
  let editorVersion = 0;
  const selectActiveExportItem: { current?: () => void } = {};
  const projectsRef: { current?: ReturnType<typeof createProjectsController> } = {};
  const markDirty = () => {
    editorVersion++;
    setDirty(true);
    projectsRef.current?.scheduleAutosave();
  };
  const previewRef: { current?: ReturnType<typeof createPreviewController> } = {};
  const exportRef: { current?: ReturnType<typeof createExportController> } = {};
  const editorFeature = createEditorController({
    selected,
    contextKey: editorContext,
    segmentIdentityScope: activeItemId,
    setStatus,
    markDirty,
    setPreviewCenterMs: (ms) => previewRef.current?.setPreviewCenterMs(ms),
    watchedPosition: () => previewRef.current?.watchedPosition() ?? editorFeature.playheadMs(),
    togglePlayback: () => previewRef.current?.togglePlayback(),
    playActiveSegment: (loop) => previewRef.current?.playActiveSegment(loop),
    playOrderedSegments: () => previewRef.current?.playOrderedSegments(),
    pausePlayback: () => previewRef.current?.pausePlayback(),
    createClips: () => exportRef.current?.exportProject(),
    onSegmentCommitted: () => {
      addMediaToProject();
      selectActiveExportItem.current?.();
    },
  });
  const {
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    timeline,
    setTimeline,
    activeSegmentIndex,
    setActiveSegmentIndex,
    activeSegment,
    editingActive,
    editingInMs,
    editingOutMs,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    present,
    playheadMs,
    duration,
    tracks,
    updateTimeline,
    updatePlaybackPosition,
    setMarker,
    startSegmentAt,
    previewMarker,
    previewSegment,
    addSegment,
    removeSegment,
    moveSegment,
    updateSegment,
    updateSegmentBoundary,
    updateSegmentLabel,
    updateSegmentIncluded,
    splitActiveSegment,
    newSegment,
  } = editorFeature;
  const exportFeature = createExportController({
    server,
    selected,
    projectId,
    revision,
    dirty,
    setDirty,
    editorVersion: () => editorVersion,
    status,
    projectItems,
    setProjectItems,
    activeItemId,
    editableItems: () => editableItems(),
    segments: () => timeline().present.segments,
    tracks: () => tracks(),
    saveProject: () => projectsFeature.saveProject(),
    settings,
    markDirty: () => markDirty(),
    saveSettings,
  });
  const {
    selectedExportItems,
    setSelectedExportItems,
    chooseExportItems,
    exportScope,
    chooseExportScope,
    exportItemIDs,
    batches,
    exportJob,
    batchJobs,
    batchId,
    exportRevision,
    exportStatus,
    exportMode,
    setExportMode,
    exportSelection,
    setExportSelection,
    cutStrategy,
    setCutStrategy,
    exportContainer,
    setExportContainer,
    streamIndexes,
    setStreamIndexes,
    destinations,
    destinationId,
    setDestinationId,
    filenameTemplate,
    setFilenameTemplate,
    preflight,
    preflightPending,
    preflightError,
    exportPending,
    destinationsLoading,
    destinationsError,
    retryDestinations,
    batchesLoading,
    batchesRefreshing,
    batchesError,
    refreshBatches,
    batchLoading,
    batchError,
    exportJobLoading,
    exportJobError,
    destinationStatus,
    exportProject,
    cancelExport,
    cancelBatch,
    cancelChildJob,
    childJobPending,
    retryChildJob,
    destinationCapabilities,
  } = exportFeature;
  selectActiveExportItem.current = () => {
    const id = activeItemId();
    if (!id) return;
    setSelectedExportItems((ids) => (ids.includes(id) ? ids : [...ids, id]));
  };
  const editableItems = () =>
    projectItems().map((item) =>
      item.id === activeItemId()
        ? {
            ...item,
            timeline: timeline(),
            muted: muted(),
            exportOptions: {
              mode: exportMode(),
              selection: exportSelection(),
              streamIndexes: streamIndexes(),
              cutStrategy: cutStrategy(),
              container: exportContainer(),
              destinationId: destinationId(),
              filenameTemplate: filenameTemplate(),
            },
          }
        : item,
    );
  const activateItem = (item: EditableProjectItem) => {
    editorFeature.prepareMediaSwitch();
    advanceEditorContext();
    setProjectItems(editableItems());
    setActiveItemId(item.id);
    setSelected(item.media);
    setTimeline(item.timeline);
    setPreviewCenterMs(item.timeline.present.playheadMs);
    setMuted(item.muted);
    setExportMode(item.exportOptions.mode ?? "merge");
    setExportSelection(item.exportOptions.selection ?? "segments");
    setStreamIndexes([...(item.exportOptions.streamIndexes ?? [])]);
    setCutStrategy(item.exportOptions.cutStrategy ?? settings().cutStrategy);
    setExportContainer(item.exportOptions.container ?? "mkv");
    setDestinationId(item.exportOptions.destinationId ?? "download");
    setFilenameTemplate(item.exportOptions.filenameTemplate ?? settings().filenameTemplate);
    setDiagnostics();
  };
  const libraryFeature = createLibraryController(server, setStatus);
  const {
    media,
    nextCursor,
    folders,
    activeFolder,
    loadingMore,
    refreshing,
    loadFolder,
    libraryMessage,
    refreshMedia: refreshLibraryMedia,
  } = libraryFeature;
  const refreshMedia = async () => {
    await refreshLibraryMedia();
    const refreshed = media().find((item) => item.id === selected()?.id);
    if (refreshed) setSelected(refreshed);
  };
  const mediaRevision = useAtomValue(() => server.mediaRevision);
  const projectMedia = new Map<
    string,
    { value: () => AsyncResult.AsyncResult<Media, Error>; dispose: () => void }
  >();
  let projectMediaContext = "";
  createEffect(() => {
    const context = `${projectId()}::${mediaRevision()}`;
    const ids = new Set(projectItems().map((item) => item.media.id));
    if (context !== projectMediaContext) {
      for (const resource of projectMedia.values()) resource.dispose();
      projectMedia.clear();
      projectMediaContext = context;
    }
    for (const [id, resource] of projectMedia) {
      if (ids.has(id)) continue;
      resource.dispose();
      projectMedia.delete(id);
    }
    for (const id of ids) {
      if (projectMedia.has(id)) continue;
      const atom = server.media(id, mediaRevision());
      let value!: () => AsyncResult.AsyncResult<Media, Error>;
      let dispose!: () => void;
      createRoot((rootDispose) => {
        const [result, setResult] = createSignal(server.registry.get(atom));
        value = result;
        const unmount = server.registry.mount(atom);
        const unsubscribe = server.registry.subscribe(atom, setResult, { immediate: true });
        dispose = () => {
          unsubscribe();
          unmount();
          rootDispose();
        };
      });
      projectMedia.set(id, { value, dispose });
    }
  });
  onCleanup(() => {
    for (const resource of projectMedia.values()) resource.dispose();
    projectMedia.clear();
  });
  const visibleMedia = () => {
    const items = [...media()];
    const ids = new Set(items.map((item) => item.id));
    for (const item of projectItems()) {
      if (ids.has(item.media.id)) continue;
      const result = projectMedia.get(item.media.id)?.value();
      items.push(result && AsyncResult.isSuccess(result) ? result.value : item.media);
      ids.add(item.media.id);
    }
    return items;
  };
  const noMedia = Atom.make(AsyncResult.initial<Media, Error>());
  const selectedMediaAtom = () => {
    const id = selected()?.id;
    return id ? server.media(id, mediaRevision()) : noMedia;
  };
  const selectedMedia = useServerAtom(selectedMediaAtom);
  createEffect(() => {
    const result = selectedMedia.result();
    if (AsyncResult.isSuccess(result) && !result.waiting && result.value.id === selected()?.id)
      setSelected(result.value);
  });
  const initializedPreviewFeature = createPreviewController(api, {
    selected,
    playheadMs,
    activeSegment,
    segments: () => present().segments,
    visibleRange: visibleTimelineRange,
    updatePlaybackPosition,
  });
  const {
    assetStatus,
    previewStatus,
    thumbnailURL,
    waveform,
    waveformVisible,
    setWaveformVisibility,
    retryAssets,
    assetRange,
    setPreviewCenterMs,
    diagnostics,
    setDiagnostics,
    playbackMode,
    playbackIntent,
    watchedPosition,
    syncPreviewPosition,
    handlePreviewEnded,
    setVideo,
    togglePlayback,
    pausePlayback,
    playSegment,
  } = initializedPreviewFeature;
  previewRef.current = initializedPreviewFeature;
  exportRef.current = exportFeature;
  const chooseMedia = (item: Media) => {
    editorFeature.prepareMediaSwitch();
    advanceEditorContext();
    clearDetectionContext();
    const items = editableItems();
    const existing = items.find((entry) => entry.media.id === item.id);
    if (existing) {
      setProjectItems(items);
      activateItem(existing);
      setStatus(`Activated ${item.name} in the project.`);
      return;
    }
    setProjectItems(items);
    setActiveItemId();
    setSelected(item);
    setTimeline(createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 }));
    setPreviewCenterMs(0);
    setMuted(settings().muted);
    setExportMode("separate");
    setExportSelection("segments");
    setStreamIndexes([]);
    setCutStrategy(settings().cutStrategy);
    setExportContainer("mkv");
    setDestinationId(lastDestinationId() ?? "download");
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
      ...createProjectItem(item, lastDestinationId()),
      timeline: timeline(),
      muted: muted(),
    };
    setProjectItems([...items, added]);
    setActiveItemId(added.id);
    setSelectedExportItems((ids) => (ids.includes(added.id) ? ids : [...ids, added.id]));
    markDirty();
    setStatus(`Added ${item.name} to the project.`);
  };
  const reorderProjectItem = (id: string, direction: -1 | 1) => {
    setProjectItems(moveProjectItem(editableItems(), id, direction));
    markDirty();
  };
  const removeProjectItem = (id: string) => {
    if (!window.confirm("Remove this media item and its unsaved edits?")) return;
    const remaining = editableItems().filter((item) => item.id !== id);
    setProjectItems(remaining);
    setSelectedExportItems((ids) => ids.filter((item) => item !== id));
    if (activeItemId() === id) {
      const next = remaining[0];
      if (next) activateItem(next);
      else {
        setActiveItemId();
        setSelected();
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
  const detectionFeature = createDetectionController(server, {
    selected,
    activeItemId,
    projectId,
    revision,
    dirty,
    editorVersion: () => editorVersion,
    saveConflict: () => projectsRef.current?.saveConflict() ?? false,
    segments: () => present().segments,
    saveProject: () => projectsFeature.saveProject(),
    updateSegments: (segments) => updateTimeline({ segments }),
  });
  const {
    detectionJob,
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    detectionLoading,
    detectionQueryError,
    clearDetectionContext,
    startDetection,
    cancelDetection,
    acceptDetection,
    rejectDetection,
    bulkAcceptDetection,
  } = detectionFeature;
  const projectsFeature = createProjectsController({
    server,
    selected,
    projectId,
    setProjectId,
    projectName,
    setProjectName,
    revision,
    setRevision,
    dirty,
    setDirty,
    projectItems,
    setProjectItems,
    setSelectedExportItems,
    setActiveItemId,
    setSelected,
    setTimeline,
    setPreviewCenterMs,
    setRecent,
    settings,
    setMuted,
    setExportMode,
    setExportSelection,
    setStreamIndexes,
    setCutStrategy,
    setExportContainer,
    setDestinationId,
    setFilenameTemplate,
    editableItems,
    editorVersion: () => editorVersion,
    contextKey: editorContext,
    resetEditorContext: advanceEditorContext,
    clearDetectionContext,
    setDiagnostics,
    setStatus,
  });
  projectsRef.current = projectsFeature;
  return {
    server,
    library: libraryFeature,
    visibleMedia,
    editorStatus: editorFeature.editorStatus,
    setEditorStatus: editorFeature.setEditorStatus,
    media,
    selected,
    nextCursor,
    folders,
    activeFolder,
    loadingMore,
    refreshing,
    status,
    setStatus,
    metadataError: () => selectedMedia.error()?.message,
    metadataLoading: () => Boolean(selected()) && selectedMedia.waiting(),
    retryMetadata: () => server.registry.refresh(selectedMediaAtom()),
    serverSettingsLoading: settingsFeature.serverSettingsLoading,
    loadServerSettings: settingsFeature.loadServerSettings,
    assetStatus,
    previewStatus,
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    thumbnailURL,
    waveform,
    waveformVisible,
    setWaveformVisibility,
    retryAssets,
    assetRange,
    setPreviewCenterMs,
    settings,
    setSettings,
    appearance,
    setAppearance,
    settingsOpen,
    setSettingsOpen,
    serverSettingsStatus,
    libraryRoots,
    settingsRevision,
    runtimeSettings,
    settingsPending,
    rescanPending,
    mcpSettings,
    mcpStatus,
    mcpLoadError,
    mcpLoading,
    loadMCPSettings,
    mcpPending,
    revealedMCPSecret,
    muted,
    setMuted,
    diagnostics,
    playbackMode,
    playbackIntent,
    loopSelectedSegment: initializedPreviewFeature.loopSelectedSegment,
    setLoopSelectedSegment: initializedPreviewFeature.setLoopSelectedSegment,
    toggleLoopSelectedSegment: initializedPreviewFeature.toggleLoopSelectedSegment,
    projectId,
    setProjectId,
    projectName,
    setProjectName,
    revision,
    setRevision,
    dirty,
    setDirty,
    projectItems,
    activeItemId,
    editorContext,
    selectedExportItems,
    setSelectedExportItems,
    chooseExportItems,
    exportScope,
    chooseExportScope,
    exportItemIDs,
    batches,
    recent,
    exportJob,
    batchJobs,
    batchId,
    exportRevision,
    exportStatus,
    exportMode,
    setExportMode,
    exportSelection,
    setExportSelection,
    cutStrategy,
    setCutStrategy,
    exportContainer,
    setExportContainer,
    streamIndexes,
    setStreamIndexes,
    destinations,
    destinationCapabilities,
    destinationId,
    setDestinationId,
    filenameTemplate,
    setFilenameTemplate,
    preflight,
    preflightPending,
    preflightError,
    exportPending,
    childJobPending,
    destinationsLoading,
    destinationsError,
    retryDestinations,
    batchesLoading,
    batchesRefreshing,
    batchesError,
    refreshBatches,
    batchLoading,
    batchError,
    exportJobLoading,
    exportJobError,
    destinationStatus,
    detectionJob,
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    detectionLoading,
    detectionQueryError,
    timeline,
    setTimeline,
    visibleTimelineRange,
    setVisibleTimelineRange,
    activeSegmentIndex,
    setActiveSegmentIndex,
    activeSegment,
    editingActive,
    editingInMs,
    editingOutMs,
    shortcutHelpOpen,
    setShortcutHelpOpen,
    playheadMs,
    editableItems,
    activateItem,
    present,
    markDirty,
    saveSettings,
    openSettings,
    saveRuntimeSettings,
    setMCPEnabled,
    createMCPCredential,
    approveExportProposal,
    revokeMCPCredential,
    rescanLibrary,
    updateTimeline,
    loadFolder,
    libraryMessage,
    refreshMedia,
    chooseMedia,
    addMediaToProject,
    reorderProjectItem,
    removeProjectItem,
    watchedPosition,
    syncPreviewPosition,
    handlePreviewEnded,
    setMarker,
    startSegmentAt,
    previewMarker,
    previewSegment,
    addSegment,
    duration,
    tracks,
    removeSegment,
    moveSegment,
    updateSegment,
    updateSegmentBoundary,
    updateSegmentLabel,
    updateSegmentIncluded,
    splitActiveSegment,
    newSegment,
    saveState: projectsFeature.saveState,
    projects: projectsFeature,
    export: exportFeature,
    exportProject,
    cancelExport,
    cancelBatch,
    cancelChildJob,
    retryChildJob,
    startDetection,
    cancelDetection,
    acceptDetection,
    rejectDetection,
    bulkAcceptDetection,
    setVideo,
    togglePlayback,
    pausePlayback,
    playActiveSegment: initializedPreviewFeature.playActiveSegment,
    playOrderedSegments: initializedPreviewFeature.playOrderedSegments,
    playDetectionCandidate: playSegment,
    playDetectionPoint: initializedPreviewFeature.playDetectionPoint,
    seekDetectionPoint: initializedPreviewFeature.seekDetectionPoint,
    undo: editorFeature.undo,
    redo: editorFeature.redo,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
