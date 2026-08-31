import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { createMutation, useQuery, useQueryClient } from "@tanstack/solid-query";
import { abortAndClear, cancellationIsCurrent } from "./cancellation";
import {
  createTimelineHistory,
  editTimeline,
  redoTimeline,
  updateTimelinePlayback,
  undoTimeline,
  type TimelineHistory,
} from "./timeline";
import { createApiClient, resolveBrowserConfiguration, validInterchangeFileSize } from "./api";
import { normalizePeaks, viewportScale } from "./assets";
import { frameDuration } from "./frame";
import {
  canStreamPreview,
  formatTime,
  hybridSmartCutKnownIneligible,
  parseTimecode,
  streamPreview,
  validateSegments,
  watchedMediaPosition,
  type PreviewDiagnostics,
  type Segment,
} from "./preview";
import { TimelineCanvas } from "./TimelineCanvas";
import { exportFailureMessage } from "./jobUi";
import { cancelJobLifecycle } from "./queryLifecycle";
import { jobPollInterval } from "./jobPolling";
import { abortCancellationControllers } from "./cancellation";
import type { components } from "./generated/api";
import { saveIsCurrent } from "./saveGuards";
import { moveSegment as moveSegments, removeSegment as removeSegments } from "./segmentEditing";
import { acceptCandidate, type Candidate, type DetectionKind } from "./detection";
import {
  confirmDiscard,
  newProjectId,
  parseProjectJson,
  projectJson,
  recentProjects,
  recentProjectsKey,
  validProjectId,
  type RecentProject,
} from "./projectLifecycle";
import { defaultSettings, settingsKey, storedSettings, type AppSettings } from "./settings";
type Media = components["schemas"]["Media"];
type FolderPage = components["schemas"]["FolderPage"];
type LibraryStatus = components["schemas"]["LibraryStatus"];
type LibraryRoot = {
  alias: string;
  state?: "ready" | "unavailable";
  message?: string;
};
type RuntimeDestination = components["schemas"]["RuntimeDestination"];

type ServerRuntimeSettings = components["schemas"]["RuntimeSettings"];

type ServerSettings = components["schemas"]["SettingsResponse"];
type Destination = components["schemas"]["Destination"];
type Project = components["schemas"]["Project"];
type ExportJob = components["schemas"]["Job"];
type DetectionJob = components["schemas"]["DetectionJob"];
const api = createApiClient(resolveBrowserConfiguration());
const durationOf = (media?: Media) => media?.durationMs ?? 0;

export function App() {
  const [media, setMedia] = createSignal<Media[]>([]);
  const [selected, setSelected] = createSignal<Media>();
  const [nextCursor, setNextCursor] = createSignal<string>();
  const [folders, setFolders] = createSignal<{ id: string; label: string }[]>([]);
  const [activeFolder, setActiveFolder] = createSignal<string>();
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [status, setStatus] = createSignal("Loading media…");
  const [libraryStatus, setLibraryStatus] = createSignal<LibraryStatus>();
  const [assetStatus, setAssetStatus] = createSignal("");
  const [segmentLabel, setSegmentLabel] = createSignal("");
  const [timecode, setTimecode] = createSignal("");
  const [thumbnailURL, setThumbnailURL] = createSignal<string>();
  const [waveform, setWaveform] = createSignal<number[]>([]);
  const [previewCenterMs, setPreviewCenterMs] = createSignal(0);
  const [settings, setSettings] = createSignal(storedSettings(localStorage));
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [serverSettingsStatus, setServerSettingsStatus] = createSignal("");
  const [libraryRoots, setLibraryRoots] = createSignal<LibraryRoot[]>([]);
  const [settingsRevision, setSettingsRevision] = createSignal(0);
  const [runtimeSettings, setRuntimeSettings] = createSignal<ServerRuntimeSettings>();
  const [settingsPending, setSettingsPending] = createSignal(false);
  const [rescanPending, setRescanPending] = createSignal(false);
  const [muted, setMuted] = createSignal(settings().muted);
  const [diagnostics, setDiagnostics] = createSignal<PreviewDiagnostics>();
  const [projectId, setProjectId] = createSignal(newProjectId());
  const [revision, setRevision] = createSignal(0);
  const [dirty, setDirty] = createSignal(false);
  const [recent, setRecent] = createSignal<RecentProject[]>(
    (() => {
      try {
        return recentProjects(JSON.parse(localStorage.getItem(recentProjectsKey) ?? "[]"));
      } catch {
        return [];
      }
    })(),
  );
  const [exportJob, setExportJob] = createSignal<ExportJob>();
  const [exportStatus, setExportStatus] = createSignal("");
  const [exportMode, setExportMode] = createSignal<"merge" | "separate">("merge");
  const [exportSelection, setExportSelection] = createSignal<"segments" | "gaps">("segments");
  const [cutStrategy, setCutStrategy] = createSignal(settings().cutStrategy);
  const [streamIndexes, setStreamIndexes] = createSignal<number[]>([]);
  const [destinations, setDestinations] = createSignal<Destination[]>([]);
  const [destinationId, setDestinationId] = createSignal("download");
  const [filenameTemplate, setFilenameTemplate] = createSignal(settings().filenameTemplate);
  const [preflight, setPreflight] = createSignal<components["schemas"]["ExportPreflight"]>();
  const [preflightPending, setPreflightPending] = createSignal(false);
  const [detectionJob, setDetectionJob] = createSignal<DetectionJob>();
  const [detectionStatus, setDetectionStatus] = createSignal("");
  const [detectionCandidates, setDetectionCandidates] = createSignal<Candidate[]>([]);
  const [timeline, setTimeline] = createSignal<TimelineHistory>(
    createTimelineHistory({
      playheadMs: 0,
      inMs: 0,
      outMs: 0,
      segments: [],
      zoom: 1,
    }),
  );
  const playheadMs = () => timeline().present.playheadMs;
  const queryClient = useQueryClient();
  const fetchProject = (id: string, signal?: AbortSignal) =>
    queryClient.fetchQuery({
      queryKey: ["project", id],
      queryFn: async ({ signal: querySignal }) => {
        const response = await api.request(`projects/${encodeURIComponent(id)}`, {
          signal: signal ?? querySignal,
        });
        if (!response.ok) throw new Error(`Project load failed (${response.status}).`);
        return (await response.json()) as Project;
      },
    });
  const saveMutation = createMutation(() => ({
    mutationFn: ({ id, body, signal }: { id: string; body: unknown; signal: AbortSignal }) =>
      api.request(`projects/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        signal,
        body: JSON.stringify(body),
      }),
  }));
  const cancelJobMutation = createMutation(() => ({
    mutationFn: ({ id, signal }: { id: string; signal: AbortSignal }) =>
      api.request(`jobs/${encodeURIComponent(id)}`, { method: "DELETE", signal }),
  }));
  const refreshMutation = createMutation(() => ({
    mutationFn: ({ signal }: { signal: AbortSignal }) =>
      api.request("media/refresh", { method: "POST", signal }),
  }));
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
  const invalidatedTerminalJobs = new Set<string>();
  const exportStatusQuery = useQuery(() => ({
    queryKey: ["job", "export", exportJob()?.id ?? null],
    enabled: Boolean(exportJob()?.id),
    queryFn: async ({ signal }) => {
      const id = exportJob()?.id;
      if (!id) throw new Error("Export job ID is missing.");
      const response = await api.request(`jobs/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Export status could not be updated. Try again.");
      return (await response.json()) as ExportJob;
    },
    refetchInterval: (query: { state: { data?: ExportJob } }) =>
      jobPollInterval(query.state.data, 1000),
  }));
  const detectionStatusQuery = useQuery(() => ({
    queryKey: ["job", "detection", detectionJob()?.id ?? null],
    enabled: Boolean(detectionJob()?.id),
    queryFn: async ({ signal }) => {
      const id = detectionJob()?.id;
      if (!id) throw new Error("Detection job ID is missing.");
      const response = await api.request(`jobs/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Detection status could not be updated.");
      return (await response.json()) as DetectionJob;
    },
    refetchInterval: (query: { state: { data?: DetectionJob } }) =>
      jobPollInterval(query.state.data, 500),
  }));
  createEffect(() => {
    const next = exportStatusQuery.data;
    if (!next || next.id !== exportJob()?.id) return;
    setExportJob(next);
    setExportStatus(
      next.state === "queued"
        ? "Export queued."
        : next.state === "running"
          ? "Export running."
          : next.state === "succeeded"
            ? "Export complete."
            : next.state === "cancelled"
              ? "Export cancelled."
              : exportFailureMessage(next.errorCode),
    );
    if (
      ["succeeded", "failed", "cancelled"].includes(next.state) &&
      !invalidatedTerminalJobs.has(next.id)
    ) {
      invalidatedTerminalJobs.add(next.id);
      void queryClient.invalidateQueries({ queryKey: ["job", "export", next.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId()] });
      void queryClient.invalidateQueries({ queryKey: ["media"] });
    }
  });
  createEffect(() => {
    const next = detectionStatusQuery.data;
    if (!next || next.id !== detectionJob()?.id) return;
    setDetectionJob(next);
    if (next.state === "succeeded") {
      setDetectionCandidates(next.candidates ?? []);
      setDetectionStatus(
        `${next.candidates?.length ?? 0} candidates found. Review each before accepting.`,
      );
    } else if (next.state === "queued" || next.state === "running") {
      setDetectionStatus(next.state === "queued" ? "Detection queued." : "Detection running.");
    } else {
      setDetectionStatus(
        next.state === "cancelled"
          ? "Detection cancelled."
          : `Detection failed${next.errorCode ? `: ${next.errorCode}.` : "."}`,
      );
    }
    if (
      ["succeeded", "failed", "cancelled"].includes(next.state) &&
      !invalidatedTerminalJobs.has(next.id)
    ) {
      invalidatedTerminalJobs.add(next.id);
      void queryClient.invalidateQueries({ queryKey: ["job", "detection", next.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", projectId()] });
      void queryClient.invalidateQueries({ queryKey: ["media"] });
    }
  });
  let video: HTMLVideoElement | undefined;
  let assetRequest: AbortController | undefined;
  let previewRequest: AbortController | undefined;
  let cleanupPreview: (() => void) | undefined;
  let thumbnailObjectURL: string | undefined;
  let projectRequest: AbortController | undefined;
  let projectRequestVersion = 0;
  let folderRequestVersion = 0;
  let saveRequest: AbortController | undefined;
  let saveVersion = 0;
  let editorVersion = 0;
  let exportTimer: number | undefined;
  let exportRequest = 0;
  let preflightVersion = 0;
  let detectionTimer: number | undefined;
  let detectionRequest = 0;
  let exportController: AbortController | undefined;
  let detectionController: AbortController | undefined;
  let exportCancellationController: AbortController | undefined;
  let detectionCancellationController: AbortController | undefined;

  const present = () => timeline().present;
  const markDirty = () => {
    editorVersion++;
    setDirty(true);
  };
  const saveSettings = (changes: Partial<AppSettings>) => {
    const next = { ...settings(), ...changes };
    setSettings(next);
    localStorage.setItem(settingsKey, JSON.stringify(next));
  };
  const loadServerSettings = async () => {
    setServerSettingsStatus("Loading administrator settings…");
    try {
      const response = await api.request("settings");
      if (response.status === 403)
        throw new Error("Administrator settings are unavailable: your account is not authorized.");
      if (!response.ok) throw new Error("Administrator settings are unavailable on this server.");
      const value = (await response.json()) as ServerSettings;
      setLibraryRoots(
        Object.entries(value.roots ?? {}).map(([alias, root]) => ({ alias, ...root })),
      );
      setSettingsRevision(value.revision);
      setRuntimeSettings(value.settings);
      setServerSettingsStatus("Administrator settings loaded.");
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error
          ? error.message
          : "Administrator settings are unavailable on this server.",
      );
    }
  };
  const openSettings = async () => {
    setSettingsOpen(true);
    await loadServerSettings();
  };

  const saveRuntimeSettings = async (
    changes: Partial<ServerRuntimeSettings>,
    successMessage: string,
  ) => {
    if (settingsPending()) return;
    setSettingsPending(true);
    setServerSettingsStatus("Saving administrator settings…");
    try {
      const current = await api.request("settings");
      if (!current.ok) throw new Error("Settings could not be reloaded before saving.");
      const value = (await current.json()) as ServerSettings;
      const response = await api.request("settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: value.revision,
          settings: { ...value.settings, ...changes },
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "Settings changed; reload before updating."
            : "Settings were rejected. Check the configured limits.",
        );
      const saved = (await response.json()) as ServerSettings;
      setSettingsRevision(saved.revision);
      setRuntimeSettings(saved.settings);
      setServerSettingsStatus(successMessage);
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Settings could not be saved.",
      );
    } finally {
      setSettingsPending(false);
    }
  };


  const updateDestination = (id: string, changes: Partial<RuntimeDestination>) => {
    const current = runtimeSettings();
    if (!current?.destinations) return;
    setRuntimeSettings({
      ...current,
      destinations: current.destinations.map((destination) =>
        destination.id === id ? { ...destination, ...changes } : destination,
      ),
    });
  };

  const saveDestinations = () =>
    void saveRuntimeSettings(
      { destinations: runtimeSettings()?.destinations },
      "Export destination settings saved.",
    );
  const rescanLibrary = async () => {
    if (rescanPending()) return;
    setRescanPending(true);
    setServerSettingsStatus("Rescanning media library…");
    try {
      const response = await api.request("settings/media/refresh", { method: "POST" });
      if (!response.ok)
        throw new Error("Media library could not be rescanned. Check mounts and permissions.");
      setServerSettingsStatus("Media library rescan started.");
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Media library rescan failed.",
      );
    } finally {
      setRescanPending(false);
    }
  };
  const updateTimeline = (changes: Partial<ReturnType<typeof present>>) => {
    const next = editTimeline(timeline(), changes);
    setTimeline(next);
    if (changes.playheadMs !== undefined) setPreviewCenterMs(next.present.playheadMs);
    markDirty();
  };
  const updatePlaybackPosition = (positionMs: number) => {
    const nextPosition = Math.max(0, Math.min(duration(), Math.round(positionMs)));
    if (nextPosition === present().playheadMs) return;
    setTimeline(updateTimelinePlayback(timeline(), nextPosition));
  };
  const loadFolder = async (folderId?: string, cursor?: string) => {
    const request = ++folderRequestVersion;
    const params = new URLSearchParams();
    if (folderId) params.set("folderId", folderId);
    if (cursor) params.set("cursor", cursor);
    const query = params.toString() ? `?${params}` : "";
    if (cursor) setLoadingMore(true);
    else setStatus("Loading media…");
    try {
      const result = await queryClient.fetchQuery({
        queryKey: ["media", "tree", folderId ?? null, cursor ?? null],
        queryFn: async ({ signal }) => {
          const response = await api.request(`media/tree${query}`, { signal });
          if (!response.ok) throw new Error(`Media request failed (${response.status}).`);
          const page = (await response.json()) as FolderPage;
          if (folderId || cursor) return { page };
          const libraryResponse = await api.request("media/status", { signal });
          return {
            page,
            library: libraryResponse.ok
              ? ((await libraryResponse.json()) as LibraryStatus)
              : undefined,
          };
        },
      });
      if (request !== folderRequestVersion) return;
      if (result.library) setLibraryStatus(result.library);
      setFolders(result.page.folders);
      setMedia(cursor ? [...media(), ...result.page.items] : result.page.items);
      setNextCursor(result.page.nextCursor ?? undefined);
      setActiveFolder(folderId);
      if (!folderId && !cursor) setStatus("Choose media to begin.");
    } catch (error) {
      if (request === folderRequestVersion)
        setStatus(error instanceof Error ? error.message : "Media request failed.");
    } finally {
      if (request === folderRequestVersion) setLoadingMore(false);
    }
  };
  createEffect(() => {
    void loadFolder();
  });
  const libraryMessage = () => {
    const current = libraryStatus();
    if (!current) return "Checking the server media library… Refresh to check again.";
    const action =
      current.state === "unconfigured"
        ? "Configure the server media root, then Refresh."
        : current.state === "scanning"
          ? "Wait for indexing to finish, then Refresh."
          : current.state === "ready_empty"
            ? "Mount supported media, then Refresh to index it."
            : current.state === "failed"
              ? "Check the server configuration, then Refresh to retry."
              : "Choose a video from the indexed library to begin.";
    return `${current.message} ${action}`;
  };

  const refreshMedia = async () => {
    folderRequestVersion++;
    setRefreshing(true);
    setActiveFolder(undefined);
    setNextCursor(undefined);
    setFolders([]);
    try {
      await queryClient.invalidateQueries({ queryKey: ["media"] });
      const response = await refreshMutation.mutateAsync({ signal: new AbortController().signal });
      if (response.status === 403) setStatus("You are not allowed to refresh media.");
      else if (response.status === 429)
        setStatus("Media refresh is already in progress. Try again shortly.");
      else if (!response.ok) setStatus("Media refresh failed. Try again.");
      else await loadFolder();
    } catch {
      setStatus("Media refresh failed. Try again.");
    } finally {
      setRefreshing(false);
    }
  };
  const invalidateSaveContext = () => {
    saveRequest?.abort();
    saveRequest = undefined;
    saveVersion++;
    editorVersion++;
  };
  const clearExportContext = () => {
    exportController = abortAndClear(exportController);
    exportCancellationController = abortAndClear(exportCancellationController);
    exportRequest++;
    if (exportTimer) window.clearTimeout(exportTimer);
    exportTimer = undefined;
    setExportJob();
    setExportStatus("");
  };
  const clearDetectionContext = () => {
    detectionController = abortAndClear(detectionController);
    detectionCancellationController = abortAndClear(detectionCancellationController);
    detectionRequest++;
    if (detectionTimer) window.clearTimeout(detectionTimer);
    detectionTimer = undefined;
    setDetectionJob();
    setDetectionCandidates([]);
    setDetectionStatus("");
  };
  const chooseMedia = (item: Media) => {
    if (!confirmDiscard(dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    clearExportContext();
    clearDetectionContext();
    invalidateSaveContext();
    setSelected(item);
    setPreviewCenterMs(0);
    setTimeline(
      createTimelineHistory({
        playheadMs: 0,
        inMs: 0,
        outMs: 0,
        segments: [],
        zoom: 1,
      }),
    );
    setDiagnostics();
    setDirty(true);
    setStatus(`Selected ${item.name}.`);
  };
  // Media root loading is owned by Solid Query; folder navigation remains explicit.
  createEffect(() => {
    const item = selected();
    assetRequest?.abort();
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
    thumbnailObjectURL = undefined;
    setThumbnailURL();
    setWaveform([]);
    setAssetStatus("");
    if (!item) return;
    const controller = new AbortController();
    assetRequest = controller;
    const durationMs = Math.max(1, Math.min(120000, item.durationMs));
    void api
      .assetRequest(
        item.id,
        "thumbnails",
        { startMs: 0, durationMs, count: 16, width: 320 },
        { signal: controller.signal },
      )
      .then((response) => {
        if (!response.ok) throw new Error();
        return response.blob();
      })
      .then((blob) => {
        if (!controller.signal.aborted) {
          thumbnailObjectURL = URL.createObjectURL(blob);
          setThumbnailURL(thumbnailObjectURL);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setAssetStatus("Thumbnails unavailable; editing remains available.");
      });
    void api
      .assetRequest(
        item.id,
        "waveform",
        { startMs: 0, durationMs, samples: 256 },
        { signal: controller.signal },
      )
      .then(async (response) => {
        const value = (await response.json()) as { peaks?: unknown };
        if (!response.ok) throw new Error();
        return normalizePeaks(value.peaks);
      })
      .then((peaks) => {
        if (!controller.signal.aborted) setWaveform(peaks);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setAssetStatus("Waveform unavailable; editing remains available.");
      });
    onCleanup(() => controller.abort());
  });
  createEffect(() => {
    const item = selected();
    const position = previewCenterMs();
    const isMuted = muted();
    cleanupPreview?.();
    cleanupPreview = undefined;
    previewRequest?.abort();
    setDiagnostics();
    const player = video;
    if (!item || !player || !canStreamPreview()) return;
    const timer = window.setTimeout(() => {
      const request = new AbortController();
      previewRequest = request;
      const params = new URLSearchParams({
        centerMs: String(Math.round(position)),
        beforeMs: "2000",
        afterMs: "6000",
        mute: String(isMuted),
      });
      setStatus("Loading preview…");
      cleanupPreview = streamPreview(
        player,
        () =>
          api.request(`media/${encodeURIComponent(item.id)}/preview?${params}`, {
            signal: request.signal,
          }),
        (value) => {
          if (!request.signal.aborted) {
            setDiagnostics(value);
            setStatus("Preview ready.");
          }
        },
        (error) => {
          if (!request.signal.aborted) setStatus(error.message);
        },
      );
    }, 200);
    onCleanup(() => {
      window.clearTimeout(timer);
      previewRequest?.abort();
      cleanupPreview?.();
      cleanupPreview = undefined;
    });
  });
  const watchedPosition = () => playheadMs();
  const syncPreviewPosition = (currentTime: number) => {
    const item = selected();
    const info = diagnostics();
    if (item && info)
      updatePlaybackPosition(watchedMediaPosition(info.startMs, currentTime, item.durationMs));
  };
  const setMarker = (kind: "inMs" | "outMs", value: number) => {
    setTimeline(editTimeline(timeline(), { [kind]: value }));
    markDirty();
  };
  const addSegment = () => {
    const item = selected();
    if (!item) return;
    const segment: Segment = {
      startMs: present().inMs,
      endMs: present().outMs,
      label: segmentLabel().trim() || undefined,
    };
    const next = [...present().segments, segment];
    const error = validateSegments(next, item.durationMs);
    if (error) return setStatus(error);
    updateTimeline({ segments: next });
  };
  const duration = () => durationOf(selected());
  const tracks = () => {
    const value = selected()?.streams.tracks;
    return Array.isArray(value)
      ? value.filter(
          (
            track,
          ): track is {
            index: number;
            type: string;
            codec: string;
            language?: string;
            disposition?: string[];
          } =>
            !!track &&
            typeof track === "object" &&
            Number.isInteger((track as { index?: unknown }).index) &&
            typeof (track as { type?: unknown }).type === "string" &&
            typeof (track as { codec?: unknown }).codec === "string" &&
            ((track as { type: string }).type === "video" ||
              (track as { type: string }).type === "audio" ||
              (track as { type: string }).type === "subtitle"),
        )
      : [];
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
  const removeSegment = (index: number) =>
    updateTimeline({ segments: removeSegments(present().segments, index) });
  const moveSegment = (index: number, direction: -1 | 1) =>
    updateTimeline({ segments: moveSegments(present().segments, index, direction) });
  const remember = (id: string, label: string) => {
    const next = [
      { id, label, lastOpened: Date.now() },
      ...recent().filter((item) => item.id !== id),
    ].slice(0, 20);
    setRecent(next);
    localStorage.setItem(recentProjectsKey, JSON.stringify(next));
  };
  const saveProject = async (): Promise<Project | undefined> => {
    const item = selected();
    const snapshotProject = projectId();
    const snapshotMedia = item?.id;
    const snapshotEditorVersion = editorVersion;
    const request = ++saveVersion;
    saveRequest?.abort();
    const controller = new AbortController();
    saveRequest = controller;
    if (!validProjectId(projectId())) return void setStatus("Project ID is invalid.");
    if (!item) return void setStatus("Select media before saving.");
    const error = validateSegments(present().segments, item.durationMs);
    if (error) return void setStatus(error);
    let response: Response;
    try {
      response = await saveMutation.mutateAsync({
        id: snapshotProject,
        signal: controller.signal,
        body: {
          mediaId: item.id,
          revision: revision(),
          segments: present().segments,
          uiState: {
            playheadMs: playheadMs(),
            zoom: present().zoom,
            muted: muted(),
          },
        },
      });
    } catch (error) {
      if (!controller.signal.aborted && request === saveVersion)
        setStatus(error instanceof Error ? error.message : "Project save failed.");
      return;
    }
    if (
      !saveIsCurrent(
        controller.signal.aborted,
        request,
        saveVersion,
        editorVersion,
        snapshotEditorVersion,
        snapshotProject,
        projectId(),
        snapshotMedia,
        selected()?.id,
      )
    )
      return;
    if (response.status === 409) {
      setStatus("Project changed on another client. Load latest before saving.");
      return;
    }
    if (!response.ok) {
      setStatus(`Project save failed (${response.status}).`);
      return;
    }
    const project = (await response.json()) as Project;
    if (
      !saveIsCurrent(
        controller.signal.aborted,
        request,
        saveVersion,
        editorVersion,
        snapshotEditorVersion,
        snapshotProject,
        projectId(),
        snapshotMedia,
        selected()?.id,
      )
    )
      return;
    setRevision(project.revision);
    await queryClient.invalidateQueries({ queryKey: ["project", project.id] });
    setDirty(false);
    remember(project.id, item.name);
    setStatus(`Project saved (revision ${project.revision}).`);
    return project;
  };
  const loadProject = async (id = projectId()) => {
    if (!validProjectId(id)) return void setStatus("Project ID is invalid.");
    if (!confirmDiscard(dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    clearExportContext();
    clearDetectionContext();
    invalidateSaveContext();
    setDiagnostics();
    projectRequest?.abort();
    const controller = new AbortController();
    projectRequest = controller;
    const request = ++projectRequestVersion;
    try {
      const project = await fetchProject(id, controller.signal);
      if (controller.signal.aborted || request !== projectRequestVersion) return;
      const item = await queryClient.fetchQuery({
        queryKey: ["media", project.mediaId],
        queryFn: async ({ signal }) => {
          const mediaResponse = await api.request(`media/${encodeURIComponent(project.mediaId)}`, {
            signal: controller.signal ?? signal,
          });
          if (!mediaResponse.ok) throw new Error(`Media request failed (${mediaResponse.status}).`);
          return (await mediaResponse.json()) as Media;
        },
      });
      if (controller.signal.aborted || request !== projectRequestVersion) return;
      setProjectId(project.id);
      setRevision(project.revision);
      setSelected(item);
      setMedia((items) => (items.some((known) => known.id === item.id) ? items : [...items, item]));
      setTimeline(
        createTimelineHistory({
          playheadMs: project.uiState.playheadMs,
          inMs: project.uiState.playheadMs,
          outMs: project.uiState.playheadMs,
          segments: project.segments,
          zoom: project.uiState.zoom,
        }),
      );
      setPreviewCenterMs(project.uiState.playheadMs);
      setMuted(project.uiState.muted);
      setDirty(false);
      remember(project.id, item.name);
      setStatus("Project loaded.");
    } catch (error) {
      if (!controller.signal.aborted && request === projectRequestVersion)
        setStatus(error instanceof Error ? error.message : "Project load failed.");
    }
  };
  const newProject = () => {
    if (!confirmDiscard(dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    clearExportContext();
    clearDetectionContext();
    invalidateSaveContext();
    projectRequest?.abort();
    ++projectRequestVersion;
    setProjectId(newProjectId());
    setRevision(0);
    setDirty(false);
    setSelected();
    setPreviewCenterMs(0);
    setMuted(false);
    setDiagnostics();
    setTimeline(
      createTimelineHistory({
        playheadMs: 0,
        inMs: 0,
        outMs: 0,
        segments: [],
        zoom: 1,
      }),
    );
    setStatus("New project ready.");
  };
  onCleanup(() => {
    saveRequest?.abort();
    assetRequest?.abort();
    previewRequest?.abort();
    projectRequest?.abort();
    cleanupPreview?.();
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
    clearExportContext();
    clearDetectionContext();
    [exportCancellationController, detectionCancellationController] = abortCancellationControllers(
      exportCancellationController,
      detectionCancellationController,
    );
    projectRequestVersion++;
    saveVersion++;
    exportController?.abort();
  });
  void api.request("destinations").then(async (response) => {
    if (!response.ok) return;
    const value = (await response.json()) as { destinations?: Destination[] };
    const items = Array.isArray(value.destinations) ? value.destinations : [];
    setDestinations(items);
    if (items.length && !items.some((item) => item.id === destinationId()))
      setDestinationId(items[0].id);
  });
  createEffect(() => {
    const item = selected();
    const currentProjectID = projectId();
    const mode = exportMode();
    const selection = exportSelection();
    const strategy = cutStrategy();
    const indexes = streamIndexes();
    revision();
    tracks();
    const destination = destinationId();
    const template = filenameTemplate();
    if (!item) {
      setPreflight(undefined);
      setPreflightPending(false);
      return;
    }
    if (exportTimer) window.clearTimeout(exportTimer);
    dirty();
    setPreflightPending(true);
    const version = ++preflightVersion;
    exportTimer = window.setTimeout(async () => {
      try {
        const response = await api.request(
          `projects/${encodeURIComponent(currentProjectID)}/exports/preflight`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode,
              selection,
              streamIndexes: indexes,
              cutStrategy: strategy,
              container: "mkv",
              destinationId: destination,
              filenameTemplate: template,
            }),
          },
        );
        if (version !== preflightVersion) return;
        if (response.ok) setPreflight(await response.json());
        else
          setPreflight({
            allowed: false,
            selection: [],
            findings: [
              {
                severity: "blocked",
                code: "preflight_failed",
                message: "Export preflight failed.",
              },
            ],
          });
      } catch {
        if (version === preflightVersion)
          setPreflight({
            allowed: false,
            selection: [],
            findings: [
              {
                severity: "blocked",
                code: "preflight_failed",
                message: "Export preflight failed.",
              },
            ],
          });
      }
      if (version === preflightVersion) setPreflightPending(false);
    }, 250);
  });
  const exportProject = async () => {
    const activeJob = exportJob();
    if (activeJob?.state === "queued" || activeJob?.state === "running") {
      setExportStatus(`Export job ${activeJob.id} is already active.`);
      return;
    }
    if (preflightPending() && !dirty()) return;
    if (dirty()) {
      if (!(await saveProject())) return;
      const response = await api.request(
        `projects/${encodeURIComponent(projectId())}/exports/preflight`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: exportMode(),
            selection: exportSelection(),
            streamIndexes: streamIndexes(),
            cutStrategy: cutStrategy(),
            container: "mkv",
            destinationId: destinationId(),
            filenameTemplate: filenameTemplate(),
          }),
        },
      );
      if (!response.ok) return void setExportStatus("Export preflight failed.");
      const freshPreflight = (await response.json()) as components["schemas"]["ExportPreflight"];
      setPreflight(freshPreflight);
      if (!freshPreflight.allowed) return;
    } else if (!preflight()?.allowed) return;
    const request = ++exportRequest;
    const controller = new AbortController();
    exportController = controller;
    if (exportTimer) clearTimeout(exportTimer);
    setExportStatus("Starting export…");
    let response: Response;
    try {
      response = await api.request(`projects/${encodeURIComponent(projectId())}/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: exportMode(),
          selection: exportSelection(),
          streamIndexes: streamIndexes(),
          cutStrategy: cutStrategy(),
          container: "mkv",
          destinationId: destinationId(),
          filenameTemplate: filenameTemplate(),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || request !== exportRequest) return;
      return setExportStatus(
        error instanceof Error ? error.message : "Export could not be started. Try again.",
      );
    }
    if (controller.signal.aborted || request !== exportRequest) return;
    if (!response.ok)
      return setExportStatus(
        response.status === 429
          ? "Export capacity is busy. Try again shortly."
          : "Export could not be started. Try again.",
      );
    if (controller.signal.aborted || request !== exportRequest) return;
    const job = (await response.json()) as ExportJob;
    if (controller.signal.aborted || request !== exportRequest) return;
    setExportJob(job);
    // Solid Query owns status polling and cancellation for this job.
  };
  const cancelExport = async () => {
    const job = exportJob();
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    exportCancellationController?.abort();
    const cancellationController = new AbortController();
    exportCancellationController = cancellationController;
    try {
      await cancelJobLifecycle({
        jobId: job.id,
        signal: cancellationController.signal,
        cancel: (id, signal) => cancelJobMutation.mutateAsync({ id, signal }),
        cancelQueries: (options) => queryClient.cancelQueries(options),
        invalidateQueries: (options) => queryClient.invalidateQueries(options),
        jobQueryKey: ["job", "export", job.id],
        projectQueryKey: ["project", projectId()],
      });
      if (!cancellationIsCurrent(cancellationController, exportCancellationController)) return;
      exportController?.abort();
      exportController = undefined;
      if (exportTimer) clearTimeout(exportTimer);
      exportTimer = undefined;
      setExportJob({ ...job, state: "cancelled" });
      setExportStatus("Export cancelled.");
    } catch (error) {
      if (!cancellationController.signal.aborted)
        setExportStatus(
          error instanceof Error ? error.message : "Export could not be cancelled. Try again.",
        );
    } finally {
      if (exportCancellationController === cancellationController)
        exportCancellationController = undefined;
    }
  };
  const startDetection = async (kind: DetectionKind) => {
    const saved = await saveProject();
    if (!saved) return;
    const request = ++detectionRequest;
    detectionController?.abort();
    const controller = new AbortController();
    detectionController = controller;
    setDetectionCandidates([]);
    setDetectionStatus(`Starting ${kind} detection…`);
    let response: Response;
    try {
      response = await api.request(`projects/${encodeURIComponent(saved.id)}/detections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaId: saved.mediaId,
          projectRevision: saved.revision,
          kind,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || request !== detectionRequest) return;
      return setDetectionStatus(
        error instanceof Error ? error.message : "Detection could not be started.",
      );
    }
    if (controller.signal.aborted || request !== detectionRequest) return;
    if (!response.ok)
      return setDetectionStatus(
        response.status === 409
          ? "Detection is stale; save or reload the project."
          : "Detection could not be started.",
      );
    if (controller.signal.aborted || request !== detectionRequest) return;
    const job = (await response.json()) as DetectionJob;
    if (controller.signal.aborted || request !== detectionRequest) return;
    setDetectionJob(job);
    // Solid Query owns status polling and cancellation for this job.
    if (job.state === "succeeded") {
      setDetectionCandidates(job.candidates ?? []);
      setDetectionStatus(
        `${job.candidates?.length ?? 0} candidates found. Review each before accepting.`,
      );
    } else if (job.state === "cancelled") setDetectionStatus("Detection cancelled.");
    else if (job.state === "queued" || job.state === "running")
      setDetectionStatus(job.state === "queued" ? "Detection queued." : "Detection running.");
    else setDetectionStatus(`Detection failed${job.errorCode ? `: ${job.errorCode}.` : "."}`);
  };
  const cancelDetection = async () => {
    const job = detectionJob();
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    const request = ++detectionRequest;
    detectionController?.abort();
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionCancellationController?.abort();
    const cancellationController = new AbortController();
    detectionCancellationController = cancellationController;
    try {
      await cancelJobLifecycle({
        jobId: job.id,
        signal: cancellationController.signal,
        cancel: (id, signal) => cancelJobMutation.mutateAsync({ id, signal }),
        cancelQueries: (options) => queryClient.cancelQueries(options),
        invalidateQueries: (options) => queryClient.invalidateQueries(options),
        jobQueryKey: ["job", "detection", job.id],
        projectQueryKey: ["project", projectId()],
      });
      if (
        request !== detectionRequest ||
        !cancellationIsCurrent(cancellationController, detectionCancellationController)
      )
        return;
      setDetectionJob({ ...job, state: "cancelled" });
      setDetectionStatus("Detection cancelled.");
    } catch (error) {
      if (request === detectionRequest && !cancellationController.signal.aborted)
        setDetectionStatus(
          error instanceof Error ? error.message : "Detection could not be cancelled. Try again.",
        );
    } finally {
      if (detectionCancellationController === cancellationController)
        detectionCancellationController = undefined;
    }
  };
  const acceptDetection = (candidate: Candidate) => {
    const item = selected();
    if (!item) return;
    const next = acceptCandidate(
      candidate,
      {
        id: projectId(),
        mediaId: item.id,
        revision: revision(),
        segments: present().segments,
      },
      item.durationMs,
    );
    if (!next)
      return setDetectionStatus("Candidate is stale, invalid, or overlaps an existing segment.");
    updateTimeline({ segments: next.segments });
    markDirty();
    setDetectionCandidates((items) => items.filter((item) => item.id !== candidate.id));
    setDetectionStatus("Candidate accepted; save the project to persist it.");
  };
  createEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = frameDuration(selected()) || 1000;
      updateTimeline({
        playheadMs: Math.max(
          0,
          Math.min(duration(), playheadMs() + (event.key === "ArrowLeft" ? -step : step)),
        ),
      });
    } else if (event.key === " ") {
      event.preventDefault();
      if (video?.paused) void video.play();
      else video?.pause();
    } else if (event.key.toLowerCase() === "i") {
      event.preventDefault();
      setMarker("inMs", watchedPosition());
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault();
      setMarker("outMs", watchedPosition());
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      const next = event.shiftKey ? redoTimeline(timeline()) : undoTimeline(timeline());
      setTimeline(next);
      setPreviewCenterMs(next.present.playheadMs);
      markDirty();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      const next = redoTimeline(timeline());
      setTimeline(next);
      setPreviewCenterMs(next.present.playheadMs);
      markDirty();
    }
  };
  return (
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
            <section class="media-panel" aria-labelledby="media-heading">
              <div class="panel-heading">
                <h2 id="media-heading">File explorer</h2>
                <button
                  class="icon-button"
                  onClick={() => void refreshMedia()}
                  disabled={refreshing()}
                  aria-label="Refresh media"
                >
                  ↻
                </button>
              </div>
              <Show when={!selected()}>
                <section class="library-setup" aria-labelledby="library-setup-heading">
                  <h3 id="library-setup-heading">Server media library</h3>
                  <p>
                    VideoCutlist indexes videos mounted on the server; the browser does not upload
                    or choose a host folder.
                  </p>
                  <p role="status">{libraryMessage()}</p>
                </section>
              </Show>
              <nav class="file-tree" aria-label="Media folders">
                <button class="folder" aria-current="page" onClick={() => void loadFolder()}>
                  ⌄ Server media library
                </button>
                <div class="folder-contents">
                  <Show when={folders().length}>
                    <ul class="folder-list" aria-label="Virtual folders">
                      <For each={folders()}>
                        {(folder) => (
                          <li>
                            <button class="folder" onClick={() => void loadFolder(folder.id)}>
                              {folder.label}
                            </button>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                  <span class="folder-label">
                    {activeFolder() ? "Videos in folder" : "Indexed videos"}
                  </span>
                  <ul class="media-list" aria-label="Media list">
                    <For each={media()}>
                      {(item) => (
                        <li>
                          <button
                            aria-pressed={selected()?.id === item.id ? "true" : "false"}
                            onClick={() => chooseMedia(item)}
                          >
                            {item.name}
                            <span>
                              {formatTime(item.durationMs, item.durationMs)} · {item.container}
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </nav>
              <Show when={nextCursor()}>
                <button
                  disabled={loadingMore()}
                  onClick={() => void loadFolder(activeFolder(), nextCursor())}
                >
                  {loadingMore() ? "Loading more…" : "Load more"}
                </button>
              </Show>
            </section>
            <section class="editor-panel" aria-labelledby="timeline-heading">
              <h2 id="timeline-heading">Timeline</h2>
              <Show
                when={selected()}
                fallback={
                  <section class="editor-onboarding" aria-labelledby="editor-onboarding-heading">
                    <h3 id="editor-onboarding-heading">Choose a video to begin</h3>
                    <p>Select a video from the Media library to unlock the editing workspace.</p>
                    <div class="locked-workflows" aria-label="Editor workflows">
                      <p>
                        <button disabled title="Select a video before opening preview.">
                          Preview
                        </button>{" "}
                        Select a video first.
                      </p>
                      <p>
                        <button disabled title="Select a video before editing the timeline.">
                          Timeline editing
                        </button>{" "}
                        Select a video first.
                      </p>
                      <p>
                        <button disabled title="Select a video before running detection.">
                          Detection
                        </button>{" "}
                        Select a video first.
                      </p>
                      <p>
                        <button disabled title="Select a video before exporting.">
                          Export
                        </button>{" "}
                        Select a video first.
                      </p>
                    </div>
                  </section>
                }
              >
                {(item) => (
                  <>
                    <p>
                      <strong>{item().name}</strong> · {formatTime(item().durationMs, duration())}
                    </p>
                    <p id="timeline-description">
                      Playhead {formatTime(playheadMs(), duration())}. In marker{" "}
                      {formatTime(present().inMs, duration())}. Out marker{" "}
                      {formatTime(present().outMs, duration())}.{" "}
                      {present().segments.length
                        ? `${present().segments.length} segment${present().segments.length === 1 ? "" : "s"} selected.`
                        : "No segments selected."}
                    </p>
                    <Show
                      when={canStreamPreview()}
                      fallback={
                        <p class="preview-unavailable" role="status">
                          Preview is unavailable in this browser. Use the timeline controls to set
                          markers manually.
                        </p>
                      }
                    >
                      <video
                        ref={(element) => {
                          video = element;
                        }}
                        controls
                        muted={muted()}
                        aria-label="Preview player"
                        data-preview-offset={diagnostics()?.offsetMs ?? 0}
                        onTimeUpdate={(event) =>
                          syncPreviewPosition(event.currentTarget.currentTime)
                        }
                        onSeeking={(event) => syncPreviewPosition(event.currentTarget.currentTime)}
                        onSeeked={(event) => syncPreviewPosition(event.currentTarget.currentTime)}
                      />
                    </Show>
                    <div
                      class="timeline-visual"
                      role="group"
                      aria-labelledby="timeline-heading timeline-description"
                      style={{ width: `${viewportScale(present().zoom) * 100}%` }}
                    >
                      <TimelineCanvas thumbnailURL={thumbnailURL()} waveform={waveform()} />
                      <span
                        class="timeline-overlay timeline-in"
                        style={{
                          transform: `translateX(${(present().inMs / duration()) * 100}%)`,
                        }}
                        aria-label="In marker"
                      />
                      <span
                        class="timeline-overlay timeline-out"
                        style={{
                          transform: `translateX(${(present().outMs / duration()) * 100}%)`,
                        }}
                        aria-label="Out marker"
                      />
                      <For each={present().segments}>
                        {(segment) => (
                          <span
                            class="timeline-segment"
                            style={{
                              left: `${(segment.startMs / duration()) * 100}%`,
                              width: `${((segment.endMs - segment.startMs) / duration()) * 100}%`,
                            }}
                            aria-label={`Segment ${formatTime(segment.startMs, duration())} to ${formatTime(segment.endMs, duration())}`}
                          />
                        )}
                      </For>
                      <span
                        class="timeline-overlay timeline-playhead"
                        style={{
                          transform: `translateX(${(playheadMs() / duration()) * 100}%)`,
                        }}
                        aria-label="Playhead"
                      />
                    </div>
                    {assetStatus() && <p role="status">{assetStatus()}</p>}
                    <input
                      id="playhead"
                      aria-label="Timeline playhead"
                      type="range"
                      min="0"
                      max={duration()}
                      step="1"
                      value={playheadMs()}
                      onInput={(event) => {
                        const value = Number(event.currentTarget.value);
                        updateTimeline({ playheadMs: value });
                        markDirty();
                      }}
                    />
                    <p>
                      In: {formatTime(present().inMs, duration())} · Out:{" "}
                      {formatTime(present().outMs, duration())}
                    </p>
                    <div class="controls">
                      <button
                        onClick={() => {
                          const step = frameDuration(selected());
                          updateTimeline({
                            playheadMs: Math.max(0, playheadMs() - (step || 1000)),
                          });
                          markDirty();
                        }}
                      >
                        Previous frame
                      </button>
                      <button
                        onClick={() => {
                          updateTimeline({
                            playheadMs: Math.min(
                              duration(),
                              playheadMs() + (frameDuration(selected()) || 1000),
                            ),
                          });
                          markDirty();
                        }}
                      >
                        Next frame
                      </button>
                      <button
                        disabled={!timeline().past.length}
                        onClick={() => {
                          const next = undoTimeline(timeline());
                          setTimeline(next);
                          setPreviewCenterMs(next.present.playheadMs);
                          markDirty();
                        }}
                      >
                        Undo
                      </button>
                      <button
                        disabled={!timeline().future.length}
                        onClick={() => {
                          const next = redoTimeline(timeline());
                          setTimeline(next);
                          setPreviewCenterMs(next.present.playheadMs);
                          markDirty();
                        }}
                      >
                        Redo
                      </button>
                      <button onClick={addSegment}>Add In/Out segment</button>
                      <button onClick={() => setMarker("inMs", watchedPosition())}>
                        Set In marker
                      </button>
                      <button
                        onClick={() => setMarker("outMs", Math.min(duration(), watchedPosition()))}
                      >
                        Set Out marker
                      </button>
                      <label>
                        Timecode{" "}
                        <input
                          value={timecode()}
                          placeholder="0:00.000"
                          onInput={(event) => setTimecode(event.currentTarget.value)}
                        />
                      </label>
                      <button
                        onClick={() => {
                          const value = parseTimecode(timecode());
                          if (value === undefined || value > duration())
                            return setStatus("Invalid timecode.");
                          updateTimeline({ playheadMs: value });
                        }}
                      >
                        Go to timecode
                      </button>
                      <label>
                        Segment label{" "}
                        <input
                          value={segmentLabel()}
                          onInput={(event) => setSegmentLabel(event.currentTarget.value)}
                        />
                      </label>
                    </div>
                    <ol aria-label="Selected segments">
                      <For each={present().segments}>
                        {(segment, index) => (
                          <li>
                            <strong>Segment {index() + 1}</strong> · {segment.label ?? "Unlabelled"}
                            :{" "}
                            <span>
                              {formatTime(segment.startMs, duration())} –{" "}
                              {formatTime(segment.endMs, duration())}
                            </span>{" "}
                            <span class="segment-duration">
                              ({formatTime(segment.endMs - segment.startMs, duration())} duration)
                            </span>{" "}
                            <button
                              aria-label={`Move segment ${index() + 1} up`}
                              onClick={() => moveSegment(index(), -1)}
                              disabled={index() === 0}
                            >
                              Move up
                            </button>{" "}
                            <button
                              aria-label={`Move segment ${index() + 1} down`}
                              onClick={() => moveSegment(index(), 1)}
                              disabled={index() === present().segments.length - 1}
                            >
                              Move down
                            </button>{" "}
                            <button onClick={() => removeSegment(index())}>Remove segment</button>
                          </li>
                        )}
                      </For>
                    </ol>
                    <label>
                      <input
                        type="checkbox"
                        checked={muted()}
                        onChange={(event) => {
                          const value = event.currentTarget.checked;
                          setMuted(value);
                          saveSettings({ muted: value });
                          markDirty();
                        }}
                      />{" "}
                      Mute preview
                    </label>
                  </>
                )}
              </Show>
            </section>
            <Show when={selected()}>
              <section class="project-panel" aria-labelledby="project-heading">
                <h2 id="project-heading">Project</h2>
                <details open>
                  <summary>Project administration and interchange</summary>
                  <label>
                    Project ID{" "}
                    <input
                      value={projectId()}
                      onInput={(event) => {
                        setProjectId(event.currentTarget.value);
                        markDirty();
                      }}
                    />
                  </label>
                  <p>
                    Revision {revision()} {dirty() ? "· unsaved changes" : "· saved"}
                  </p>
                  <p>
                    Interchange files update cut lists; they do not upload or add a video. Videos
                    are indexed from the server&apos;s media library; configure its media roots,
                    then choose a video from File explorer.
                  </p>
                  <div class="controls">
                    <button onClick={newProject}>New project</button>
                    <button onClick={() => void loadProject()}>Load project</button>
                    <button onClick={() => void saveProject()}>Save project</button>
                    <button
                      disabled={!selected()}
                      onClick={() => {
                        const blob = new Blob(
                          [
                            projectJson({
                              version: 1,
                              mediaId: selected()!.id,
                              revision: revision(),
                              segments: present().segments,
                              uiState: {
                                playheadMs: playheadMs(),
                                zoom: present().zoom,
                                muted: muted(),
                              },
                            }),
                          ],
                          { type: "application/json" },
                        );
                        const link = document.createElement("a");
                        link.href = URL.createObjectURL(blob);
                        link.download = `${projectId()}.videocutlist.json`;
                        link.click();
                        URL.revokeObjectURL(link.href);
                      }}
                    >
                      Download cut list
                    </button>
                    <Show
                      when={selected()}
                      fallback={<p>Choose a video from File explorer to import a cut list.</p>}
                    >
                      <label>
                        Import cut list{" "}
                        <input
                          type="file"
                          accept="application/json,.json"
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            if (!file) return;
                            void file
                              .text()
                              .then((text) => {
                                const imported = parseProjectJson(text);
                                if (!selected() || imported.mediaId !== selected()!.id)
                                  throw new Error("Select the cut list's media before importing.");
                                const segments = imported.segments as Segment[];
                                const error = validateSegments(segments, selected()!.durationMs);
                                if (error) throw new Error(error);
                                updateTimeline({ segments });
                                markDirty();
                                setStatus("Cut list imported. Save the project to keep it.");
                              })
                              .catch((error) =>
                                setStatus(
                                  error instanceof Error
                                    ? error.message
                                    : "Cut list import failed.",
                                ),
                              );
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                    </Show>
                    <Show
                      when={selected() && !dirty()}
                      fallback={
                        <p>
                          Save or load the selected video&apos;s project before importing CSV or
                          chapters.
                        </p>
                      }
                    >
                      <label>
                        Import CSV or chapters{" "}
                        <input
                          type="file"
                          accept=".csv,.txt,text/csv,text/plain"
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            if (!file || !validInterchangeFileSize(file.size)) {
                              setStatus("Interchange file exceeds the 1 MiB limit.");
                              return;
                            }
                            const format = file.name.toLowerCase().endsWith(".csv")
                              ? "csv"
                              : "chapters";
                            void file
                              .arrayBuffer()
                              .then((body) =>
                                api.interchangeRequest(projectId(), format, {
                                  method: "POST",
                                  body,
                                  headers: {
                                    "Content-Type": format === "csv" ? "text/csv" : "text/plain",
                                  },
                                }),
                              )
                              .then(async (response) => {
                                if (!response.ok) throw new Error();
                                const value = (await response.json()) as {
                                  segments: Segment[];
                                  revision: number;
                                };
                                updateTimeline({ segments: value.segments });
                                setRevision(value.revision);
                                setDirty(false);
                                setStatus("Interchange imported.");
                              })
                              .catch(() => setStatus("Interchange import failed."));
                            event.currentTarget.value = "";
                          }}
                        />
                      </label>
                    </Show>
                    <p>
                      Save or load the selected video&apos;s project before exporting CSV or
                      chapters.
                    </p>
                    <button
                      disabled={!selected() || dirty()}
                      onClick={() =>
                        void api
                          .interchangeRequest(projectId(), "csv")
                          .then((response) => (response.ok ? response.blob() : Promise.reject()))
                          .then((blob) => {
                            const link = document.createElement("a");
                            link.href = URL.createObjectURL(blob);
                            link.download = `${projectId()}.csv`;
                            link.click();
                            URL.revokeObjectURL(link.href);
                          })
                          .catch(() => setStatus("CSV export failed."))
                      }
                    >
                      Export CSV
                    </button>
                    <button
                      disabled={!selected() || dirty()}
                      onClick={() =>
                        void api
                          .interchangeRequest(projectId(), "chapters")
                          .then((response) => (response.ok ? response.blob() : Promise.reject()))
                          .then((blob) => {
                            const link = document.createElement("a");
                            link.href = URL.createObjectURL(blob);
                            link.download = `${projectId()}.chapters.txt`;
                            link.click();
                            URL.revokeObjectURL(link.href);
                          })
                          .catch(() => setStatus("Chapters export failed."))
                      }
                    >
                      Export chapters
                    </button>
                  </div>
                  <Show when={recent().length > 0}>
                    <h3>Recent projects</h3>
                    <ul>
                      {recent().map((item) => (
                        <li>
                          <button onClick={() => void loadProject(item.id)}>
                            {item.label} ({item.id})
                          </button>
                        </li>
                      ))}
                    </ul>
                  </Show>
                </details>
              </section>
            </Show>
            <Show when={selected()}>
              <section class="export-panel" aria-labelledby="export-heading">
                <h2 id="export-heading">Export</h2>
                <p role="status">{exportStatus() || "Export a saved project."}</p>
                <details open>
                  <summary>Advanced export options</summary>
                  <label>
                    Mode{" "}
                    <select
                      value={exportMode()}
                      onChange={(event) =>
                        setExportMode(event.currentTarget.value as "merge" | "separate")
                      }
                    >
                      <option value="merge">Merge</option>
                      <option value="separate">Separate</option>
                    </select>
                  </label>
                  <label>
                    Selection{" "}
                    <select
                      value={exportSelection()}
                      onChange={(event) =>
                        setExportSelection(event.currentTarget.value as "segments" | "gaps")
                      }
                    >
                      <option value="segments">Segments</option>
                      <option value="gaps">Gaps</option>
                    </select>
                  </label>
                  <fieldset>
                    <legend>Streams</legend>
                    <For each={tracks()}>
                      {(track) => {
                        const checked = () =>
                          streamIndexes().length === 0 || streamIndexes().includes(track.index);
                        return (
                          <label>
                            <input
                              type="checkbox"
                              checked={checked()}
                              onChange={(event) => {
                                const all = streamIndexes().length
                                  ? streamIndexes()
                                  : tracks().map((item) => item.index);
                                setStreamIndexes(
                                  event.currentTarget.checked
                                    ? [...new Set([...all, track.index])]
                                    : all.filter((index) => index !== track.index),
                                );
                              }}
                            />{" "}
                            {track.type} {track.codec}
                            {track.language ? ` · ${track.language}` : ""}
                            {track.disposition?.length
                              ? ` · ${track.disposition.join(", ")}`
                              : ""}{" "}
                            (#
                            {track.index})
                          </label>
                        );
                      }}
                    </For>
                  </fieldset>
                  <label>
                    Cut strategy{" "}
                    <select
                      value={cutStrategy()}
                      onChange={(event) => {
                        const value = event.currentTarget.value as AppSettings["cutStrategy"];
                        setCutStrategy(value);
                        saveSettings({ cutStrategy: value });
                      }}
                    >
                      <option value="stream_copy_preferred">Stream copy preferred</option>
                      <option value="precise_reencode">Precise re-encode</option>
                      <option
                        value="hybrid_smart_cut"
                        disabled={hybridSmartCutKnownIneligible(selected())}
                      >
                        Hybrid smart cut
                        {hybridSmartCutKnownIneligible(selected()) ? " (unavailable)" : ""}
                      </option>
                    </select>
                  </label>
                  <label>
                    Destination{" "}
                    <select
                      value={destinationId()}
                      onChange={(event) => setDestinationId(event.currentTarget.value)}
                    >
                      <For each={destinations()}>
                        {(destination) => (
                          <option value={destination.id}>
                            {destination.label} ({destination.retention ?? "durable"})
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                  <label>
                    Filename template{" "}
                    <input
                      value={filenameTemplate()}
                      onInput={(event) => {
                        const value = event.currentTarget.value;
                        setFilenameTemplate(value);
                        saveSettings({ filenameTemplate: value });
                      }}
                      aria-label="Filename template"
                    />
                  </label>
                  <p role="status">
                    Preview:{" "}
                    {filenameTemplate()
                      .replaceAll("{ext}", "mkv")
                      .replaceAll("{segment}", "1")
                      .replaceAll("{mode}", exportMode()) || "server default"}
                  </p>
                </details>
                <div aria-label="Export review">
                  <p>
                    Scope: {exportSelection()} · {present().segments.length} segment
                    {present().segments.length === 1 ? "" : "s"} ·{" "}
                    {formatTime(
                      present().segments.reduce(
                        (total, segment) => total + segment.endMs - segment.startMs,
                        0,
                      ),
                      duration(),
                    )}{" "}
                    total
                  </p>
                  <p>
                    Destination:{" "}
                    {destinations().find((item) => item.id === destinationId())?.label ??
                      destinationId()}
                  </p>
                  <p>
                    Filename:{" "}
                    {filenameTemplate()
                      .replaceAll("{ext}", "mkv")
                      .replaceAll("{segment}", "1")
                      .replaceAll("{mode}", exportMode()) || "server default"}
                  </p>
                  <p>
                    Review: {exportMode()} {exportSelection()} · {cutStrategy()}
                  </p>
                  <p>
                    Requested segment bounds:{" "}
                    {present()
                      .segments.map(
                        (segment) =>
                          `${formatTime(segment.startMs, duration())}–${formatTime(segment.endMs, duration())}`,
                      )
                      .join(", ") || "none"}
                  </p>
                  <p>
                    Selected streams: {preflight()?.selection?.join(", ") || "default safe streams"}
                  </p>
                  <Show when={cutStrategy() === "stream_copy_preferred"}>
                    <p>
                      Stream-copy cuts may begin at an earlier keyframe; no frame-exactness is
                      claimed.
                    </p>
                  </Show>
                  <Show when={cutStrategy() !== "stream_copy_preferred"}>
                    <p>
                      Boundary precision depends on the selected strategy and requires human review.
                    </p>
                  </Show>
                  <For each={preflight()?.findings ?? []}>
                    {(finding) => (
                      <p role="status">
                        {finding.severity}: {finding.message}
                      </p>
                    )}
                  </For>
                </div>
                <div class="controls">
                  <Show when={exportJob()?.state === "queued" || exportJob()?.state === "running"}>
                    <p role="status">Export job {exportJob()!.id} is active; wait or cancel it.</p>
                  </Show>
                  <button
                    aria-label="Start export"
                    disabled={
                      !selected() ||
                      !present().segments.length ||
                      (preflightPending() && !dirty()) ||
                      (!preflight()?.allowed && !dirty()) ||
                      exportJob()?.state === "queued" ||
                      exportJob()?.state === "running"
                    }
                    onClick={() => void exportProject()}
                  >
                    Export {present().segments.length} segment
                    {present().segments.length === 1 ? "" : "s"}
                  </button>
                  <Show when={exportJob()?.state === "queued" || exportJob()?.state === "running"}>
                    <button onClick={() => void cancelExport()}>Cancel export</button>
                  </Show>
                </div>
                <Show when={exportJob()?.result}>
                  <div>
                    <div aria-label="Export result">
                      <p>
                        Output ready:{" "}
                        {exportJob()!.result!.outputName ??
                          exportJob()!.result!.outputNames?.join(", ")}
                      </p>
                      <p>
                        Strategy:{" "}
                        {exportJob()!.appliedStrategy ??
                          (exportJob()!.result!.appliedStrategies?.length
                            ? "mixed per segment"
                            : (exportJob()!.strategy ?? cutStrategy()))}{" "}
                        · {exportJob()!.verified ? "verified output" : "requires inspection"}
                      </p>
                      <Show when={(exportJob()!.result!.appliedStrategies?.length ?? 0) > 1}>
                        <For each={exportJob()!.result!.appliedStrategies}>
                          {(strategy) => (
                            <p>
                              Segment {strategy.segment}
                              {strategy.outputName ? ` (${strategy.outputName})` : ""}:{" "}
                              {strategy.strategy}
                            </p>
                          )}
                        </For>
                      </Show>
                      <p>
                        {exportJob()!.result!.sizeBytes.toLocaleString()} bytes · retained until{" "}
                        {exportJob()!.result!.retainUntil}
                      </p>
                    </div>
                    <Show
                      when={
                        exportJob()!.state === "succeeded" &&
                        exportJob()!.result!.destinationKind === "download"
                      }
                    >
                      <For
                        each={
                          exportJob()!.result!.outputNames ??
                          (exportJob()!.result!.outputName ? [exportJob()!.result!.outputName] : [])
                        }
                      >
                        {(_, position) => (
                          <a
                            href={api.url(
                              `jobs/${encodeURIComponent(exportJob()!.id)}/outputs/${position()}`,
                            )}
                            download=""
                          >
                            Download output {position() + 1}
                          </a>
                        )}
                      </For>
                    </Show>
                    <p role="note">Please review the exported media before delivery.</p>
                    <div aria-label="Export warnings">
                      <For each={exportJob()!.warnings ?? []}>
                        {(warning) => <p role="status">Warning: {warning}</p>}
                      </For>
                    </div>
                  </div>
                </Show>
              </section>
            </Show>
            <Show when={selected()}>
              <section class="detection-panel" aria-labelledby="detection-heading">
                <h2 id="detection-heading">Auto detection</h2>
                <details open>
                  <summary>Detection tools</summary>
                  <p role="status">
                    {detectionStatus() || "Review candidates before they change segments."}
                  </p>
                  <div class="controls">
                    <button
                      disabled={
                        !selected() ||
                        detectionJob()?.state === "queued" ||
                        detectionJob()?.state === "running"
                      }
                      onClick={() => void startDetection("silence")}
                    >
                      Detect silence
                    </button>
                    <button
                      disabled={
                        !selected() ||
                        detectionJob()?.state === "queued" ||
                        detectionJob()?.state === "running"
                      }
                      onClick={() => void startDetection("black")}
                    >
                      Detect black frames
                    </button>
                    <button
                      disabled={
                        !selected() ||
                        detectionJob()?.state === "queued" ||
                        detectionJob()?.state === "running"
                      }
                      onClick={() => void startDetection("scene")}
                    >
                      Detect scene changes
                    </button>
                    <Show
                      when={
                        detectionJob()?.state === "queued" || detectionJob()?.state === "running"
                      }
                    >
                      <button onClick={() => void cancelDetection()}>Cancel detection</button>
                    </Show>
                  </div>
                  <Show when={detectionCandidates().length > 0}>
                    <ol aria-label="Detection candidates">
                      <For each={detectionCandidates()}>
                        {(candidate) => (
                          <li>
                            {candidate.source} · {formatTime(candidate.startMs, duration())}–
                            {formatTime(candidate.endMs, duration())} ·{" "}
                            {Math.round(candidate.confidence * 100)}%{" "}
                            <button onClick={() => acceptDetection(candidate)}>Accept</button>
                            <button
                              onClick={() => {
                                setDetectionCandidates(
                                  detectionCandidates().filter((item) => item.id !== candidate.id),
                                );
                                setDetectionStatus("Candidate rejected.");
                              }}
                            >
                              Reject
                            </button>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                </details>
              </section>
            </Show>
          </>
        }
      >
        <section class="settings-view" aria-labelledby="settings-heading">
          <div class="panel-heading">
            <h2 id="settings-heading">Settings</h2>
            <button type="button" onClick={() => setSettingsOpen(false)}>
              Back to editor
            </button>
          </div>
          <p>
            Browser-local preferences stay in this browser and do not change server configuration.
          </p>
          <section aria-labelledby="library-settings-heading">
            <h3 id="library-settings-heading">Library</h3>
            <p>Media roots are deployment-managed. This browser only shows safe aliases and availability.</p>
            <Show when={libraryRoots().length > 0} fallback={<p>No media roots configured.</p>}>
              <div class="library-roots" aria-label="Media roots">
                <For each={libraryRoots()}>
                  {(root) => (
                    <div class="library-root">
                      <span>
                        Alias: <strong>{root.alias}</strong>
                      </span>
                      <span role="status">
                        {root.state === "unavailable"
                          ? root.message
                          : (root.message ?? "Available")}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <div class="settings-actions">
              <button
                type="button"
                onClick={() => void rescanLibrary()}
                disabled={rescanPending() || settingsPending()}
              >
                {rescanPending() ? "Rescanning…" : "Rescan library"}
              </button>
            </div>
            <p class="settings-revision">Settings revision {settingsRevision()}</p>
          </section>
          <section aria-labelledby="exports-settings-heading">
            <h3 id="exports-settings-heading">Exports</h3>
            <p>
              Source media is read-only. Exports are retained according to each destination policy;
              cache data is disposable.
            </p>
            <label>
              Cut strategy (saved in this browser)
              <select
                value={cutStrategy()}
                onChange={(event) => {
                  const value = event.currentTarget.value as AppSettings["cutStrategy"];
                  setCutStrategy(value);
                  saveSettings({ cutStrategy: value });
                }}
              >
                <option value="stream_copy_preferred">Stream copy preferred</option>
                <option value="precise_reencode">Precise re-encode</option>
                <option value="hybrid_smart_cut">Hybrid smart cut</option>
              </select>
            </label>
            <label>
              Filename template (saved in this browser)
              <input
                value={filenameTemplate()}
                onInput={(event) => {
                  const value = event.currentTarget.value;
                  setFilenameTemplate(value);
                  saveSettings({ filenameTemplate: value });
                }}
              />
            </label>
            <Show when={runtimeSettings()?.destinations?.length}>
              <h4>Destinations</h4>
              <ul>
                <For each={runtimeSettings()?.destinations}>
                  {(destination) => (
                    <li>
                      <label>
                        Name
                        <input
                          value={destination.label}
                          onChange={(event) =>
                            updateDestination(destination.id, { label: event.currentTarget.value })
                          }
                        />
                      </label>
                      <label>
                        Description
                        <input
                          value={destination.description ?? ""}
                          onChange={(event) =>
                            updateDestination(destination.id, {
                              description: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        Retention
                        <input
                          value={destination.retention ?? ""}
                          placeholder="for example 30d"
                          onChange={(event) =>
                            updateDestination(destination.id, {
                              retention: event.currentTarget.value,
                            })
                          }
                        />
                      </label>
                      <span>{destination.kind} · deployment-managed location</span>
                    </li>
                  )}
                </For>
              </ul>
              <button type="button" onClick={saveDestinations} disabled={settingsPending()}>
                {settingsPending() ? "Saving…" : "Save destination settings"}
              </button>
              <p>
                Destination roots are deployment-controlled and remain within configured export
                bases.
              </p>
            </Show>
          </section>
          <section aria-labelledby="performance-settings-heading">
            <h3 id="performance-settings-heading">Performance</h3>
            <p>Changes apply to the next job; running FFmpeg jobs are not reconfigured.</p>
            <label>
              Export concurrency{" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.exportLimit ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { exportLimit: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Preview global concurrency{" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.previewGlobalLimit ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { previewGlobalLimit: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Preview before (ms){" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.previewBeforeMs ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { previewBeforeMs: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Preview after (ms){" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.previewAfterMs ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { previewAfterMs: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Preview maximum window (ms){" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.previewMaxMs ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { previewMaxMs: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Preview grid (ms){" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.previewGridMs ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { previewGridMs: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Media scan file limit{" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.mediaMaxFiles ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { mediaMaxFiles: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Media scan depth limit{" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.mediaMaxDepth ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { mediaMaxDepth: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
            <label>
              Disposable cache size (bytes){" "}
              <input
                type="number"
                min="1"
                value={runtimeSettings()?.cacheMaxBytes ?? ""}
                onChange={(event) =>
                  void saveRuntimeSettings(
                    { cacheMaxBytes: event.currentTarget.valueAsNumber },
                    "Performance settings saved.",
                  )
                }
              />
            </label>
          </section>
          <section aria-labelledby="editor-settings-heading">
            <h3 id="editor-settings-heading">Editor</h3>
            <label>
              <input
                type="checkbox"
                checked={muted()}
                onChange={(event) => {
                  const value = event.currentTarget.checked;
                  setMuted(value);
                  saveSettings({ muted: value });
                }}
              />{" "}
              Mute preview by default (saved in this browser)
            </label>
            <button
              type="button"
              onClick={() => {
                setSettings(defaultSettings);
                setCutStrategy(defaultSettings.cutStrategy);
                setFilenameTemplate(defaultSettings.filenameTemplate);
                setMuted(defaultSettings.muted);
                localStorage.setItem(settingsKey, JSON.stringify(defaultSettings));
              }}
            >
              Reset browser preferences
            </button>
          </section>
          <section aria-labelledby="about-settings-heading">
            <h3 id="about-settings-heading">About / Diagnostics</h3>
            <p>Preview request and cache diagnostics are kept out of the clipping workspace.</p>
            <details>
              <summary>Preview diagnostics</summary>
              <dl>
                <dt>MSE</dt>
                <dd>{canStreamPreview() ? "supported" : "unsupported"}</dd>
                <dt>Cache</dt>
                <dd>{diagnostics()?.cache ?? "—"}</dd>
                <dt>Request ID</dt>
                <dd>{diagnostics()?.requestId ?? "—"}</dd>
                <dt>Offset</dt>
                <dd>{diagnostics() ? `${diagnostics()!.offsetMs} ms` : "—"}</dd>
                <dt>Window</dt>
                <dd>
                  {diagnostics()
                    ? `${diagnostics()!.startMs} ms / ${diagnostics()!.durationMs} ms`
                    : "—"}
                </dd>
                <dt>Response</dt>
                <dd>{diagnostics() ? `${diagnostics()!.elapsedMs} ms` : "—"}</dd>
              </dl>
            </details>
            <p role="status">{serverSettingsStatus()}</p>
          </section>
        </section>
      </Show>
    </main>
  );
}
