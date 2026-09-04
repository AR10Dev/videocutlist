import { createEffect, createSignal, onCleanup } from "solid-js";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createApiClient, resolveBrowserConfiguration } from "../../api";
import { createPreviewController } from "../preview/controller";
import type { components } from "../../generated/api";
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
import { createEditorController } from "../editor/controller";
type Media = components["schemas"]["Media"];
const api = createApiClient(resolveBrowserConfiguration());

export function createWorkspaceController() {
  const [selected, setSelected] = createSignal<Media>();
  const [status, setStatus] = createSignal("Loading media…");
  const settingsFeature = createSettingsController(api);
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
    saveSettings,
    openSettings,
    saveRuntimeSettings,
    updateDestination,
    saveDestinations,
    rescanLibrary,
  } = settingsFeature;
  const [muted, setMuted] = createSignal(settings().muted);
  const [projectId, setProjectId] = createSignal(newProjectId());
  const [projectName, setProjectName] = createSignal("Untitled project");
  const [revision, setRevision] = createSignal(0);
  const [dirty, setDirty] = createSignal(false);
  const [projectItems, setProjectItems] = createSignal<EditableProjectItem[]>([]);
  const [activeItemId, setActiveItemId] = createSignal<string>();
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
  const markDirty = () => {
    editorVersion++;
    setDirty(true);
  };
  const previewRef: { current?: ReturnType<typeof createPreviewController> } = {};
  const editorFeature = createEditorController({
    selected,
    setStatus,
    markDirty,
    setPreviewCenterMs: (ms) => previewRef.current?.setPreviewCenterMs(ms),
    watchedPosition: () => previewRef.current?.watchedPosition() ?? editorFeature.playheadMs(),
    togglePlayback: () => previewRef.current?.togglePlayback(),
  });
  const {
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    timeline,
    setTimeline,
    present,
    playheadMs,
    duration,
    tracks,
    updateTimeline,
    updatePlaybackPosition,
    setMarker,
    addSegment,
    removeSegment,
    moveSegment,
  } = editorFeature;
  const queryClient = useQueryClient();
  const exportFeature = createExportController({
    api,
    queryClient,
    selected,
    projectId,
    revision,
    dirty,
    setDirty,
    projectItems,
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
    streamIndexes,
    setStreamIndexes,
    destinations,
    destinationId,
    setDestinationId,
    filenameTemplate,
    setFilenameTemplate,
    preflight,
    preflightPending,
    exportProject,
    cancelExport,
    cancelBatch,
    cancelChildJob,
    retryChildJob,
  } = exportFeature;
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
              container: "mkv" as const,
              destinationId: destinationId(),
              filenameTemplate: filenameTemplate(),
            },
          }
        : item,
    );
  const activateItem = (item: EditableProjectItem) => {
    setProjectItems(editableItems());
    setActiveItemId(item.id);
    setSelected(item.media);
    setTimeline(item.timeline);
    setPreviewCenterMs(item.timeline.present.playheadMs);
    setMuted(item.muted);
    setExportMode(item.exportOptions.mode ?? "merge");
    setExportSelection(item.exportOptions.selection ?? "segments");
    setStreamIndexes(item.exportOptions.streamIndexes ?? []);
    setCutStrategy(item.exportOptions.cutStrategy ?? settings().cutStrategy);
    setDestinationId(item.exportOptions.destinationId ?? "download");
    setFilenameTemplate(item.exportOptions.filenameTemplate ?? settings().filenameTemplate);
    setDiagnostics();
  };
  const libraryFeature = createLibraryController(api, queryClient, setStatus);
  const {
    media,
    setMedia,
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
    if (refreshed) {
      queryClient.setQueryData(["media", refreshed.id], refreshed);
      setSelected(refreshed);
    }
  };
  const selectedMediaQuery = useQuery(() => ({
    queryKey: ["media", selected()?.id ?? null],
    enabled: Boolean(selected()?.id),
    queryFn: async ({ signal }) => {
      const id = selected()?.id;
      if (!id) throw new Error("Media ID is missing.");
      const response = await api.request(`media/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error(`Metadata request failed (${response.status}).`);
      return (await response.json()) as Media;
    },
  }));
  createEffect(() => {
    const item = selectedMediaQuery.data;
    if (item && item.id === selected()?.id) setSelected(item);
    if (selectedMediaQuery.error && selected()?.id)
      setStatus(
        selectedMediaQuery.error instanceof Error
          ? selectedMediaQuery.error.message
          : "Metadata request failed.",
      );
  });
  const initializedPreviewFeature = createPreviewController(api, {
    selected,
    muted,
    playheadMs,
    updatePlaybackPosition,
  });
  const {
    assetStatus,
    previewStatus,
    thumbnailURL,
    waveform,
    setPreviewCenterMs,
    diagnostics,
    setDiagnostics,
    watchedPosition,
    syncPreviewPosition,
    setVideo,
    togglePlayback,
  } = initializedPreviewFeature;
  previewRef.current = initializedPreviewFeature;
  const chooseMedia = (item: Media) => {
    clearDetectionContext();
    const items = editableItems();
    const existing = items.find((entry) => entry.media.id === item.id);
    if (existing) {
      setProjectItems(items);
      activateItem(existing);
      setStatus(`Selected ${item.name}.`);
      return;
    }
    const added = createProjectItem(item);
    setProjectItems([...items, added]);
    setSelectedExportItems((ids) => [...ids, added.id]);
    activateItem(added);
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
  onCleanup(() => {
    projectsFeature.dispose();
    clearDetectionContext();
  });
  const detectionFeature = createDetectionController(api, queryClient, {
    selected,
    activeItemId,
    projectId,
    revision,
    segments: () => present().segments,
    saveProject: () => projectsFeature.saveProject(),
    updateSegments: (segments) => updateTimeline({ segments }),
    markDirty,
  });
  const {
    detectionJob,
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    clearDetectionContext,
    startDetection,
    cancelDetection,
    acceptDetection,
  } = detectionFeature;
  const projectsFeature = createProjectsController({
    api,
    queryClient,
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
    setMedia,
    setRecent,
    settings,
    setMuted,
    setExportMode,
    setExportSelection,
    setStreamIndexes,
    setCutStrategy,
    setDestinationId,
    setFilenameTemplate,
    editableItems,
    editorVersion: () => editorVersion,
    clearDetectionContext,
    setDiagnostics,
    setStatus,
  });
  return {
    media,
    selected,
    nextCursor,
    folders,
    activeFolder,
    loadingMore,
    refreshing,
    status,
    setStatus,
    assetStatus,
    previewStatus,
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    thumbnailURL,
    waveform,
    setPreviewCenterMs,
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
    muted,
    setMuted,
    diagnostics,
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
    selectedExportItems,
    setSelectedExportItems,
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
    streamIndexes,
    setStreamIndexes,
    destinations,
    destinationId,
    setDestinationId,
    filenameTemplate,
    setFilenameTemplate,
    preflight,
    preflightPending,
    detectionJob,
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    timeline,
    setTimeline,
    playheadMs,
    editableItems,
    activateItem,
    present,
    markDirty,
    saveSettings,
    openSettings,
    saveRuntimeSettings,
    updateDestination,
    saveDestinations,
    rescanLibrary,
    updateTimeline,
    loadFolder,
    libraryMessage,
    refreshMedia,
    chooseMedia,
    reorderProjectItem,
    removeProjectItem,
    watchedPosition,
    syncPreviewPosition,
    setMarker,
    addSegment,
    duration,
    tracks,
    removeSegment,
    moveSegment,
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
    setVideo,
    togglePlayback,
  };
}

export type WorkspaceController = ReturnType<typeof createWorkspaceController>;
