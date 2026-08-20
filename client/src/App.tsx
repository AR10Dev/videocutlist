import { For, Show, createEffect, createSignal, onCleanup, onSettled } from "solid-js";
import {
  createTimelineHistory,
  editTimeline,
  redoTimeline,
  undoTimeline,
  type TimelineHistory,
} from "./timeline";
import { createApiClient, resolveBrowserConfiguration } from "./api";
import { normalizePeaks, viewportScale } from "./assets";
import { frameDuration } from "./frame";
import {
  acceptsMediaMetadata,
  canStreamPreview,
  formatTime,
  hybridSmartCutKnownIneligible,
  parseTimecode,
  streamPreview,
  validateSegments,
  watchedMediaPosition,
  type Media,
  type PreviewDiagnostics,
  type Segment,
} from "./preview";
import { TimelineCanvas } from "./TimelineCanvas";
import { exportFailureMessage } from "./jobUi";
import { saveIsCurrent } from "./saveGuards";
import { moveSegment as moveSegments, removeSegment as removeSegments } from "./segmentEditing";
import {
  acceptCandidate,
  type Candidate,
  type DetectionKind,
} from "./detection";
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

type MediaPage = { items: Media[]; nextCursor?: string | null };
type Project = {
  id: string;
  mediaId: string;
  revision: number;
  segments: Segment[];
  uiState: { playheadMs: number; zoom: number; muted: boolean };
};
type ExportJob = {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
    result?: {
    outputName?: string;
    outputNames?: string[];
    sizeBytes: number;
    retainUntil: string;
  };
  warnings?: string[];
  errorCode?: string;
};
type DetectionJob = {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  candidates?: Candidate[];
  errorCode?: string;
};
const api = createApiClient(resolveBrowserConfiguration());
const durationOf = (media?: Media) => media?.durationMs ?? 0;

export function App() {
  const [media, setMedia] = createSignal<Media[]>([]);
  const [selected, setSelected] = createSignal<Media>();
  const [nextCursor, setNextCursor] = createSignal<string>();
  const [loadingMore, setLoadingMore] = createSignal(false);
  const [refreshing, setRefreshing] = createSignal(false);
  const [status, setStatus] = createSignal("Loading media…");
  const [assetStatus, setAssetStatus] = createSignal("");
  const [segmentLabel, setSegmentLabel] = createSignal("");
  const [timecode, setTimecode] = createSignal("");
  const [thumbnailURL, setThumbnailURL] = createSignal<string>();
  const [waveform, setWaveform] = createSignal<number[]>([]);
  const [playheadMs, setPlayheadMs] = createSignal(0);
  const [muted, setMuted] = createSignal(false);
  const [diagnostics, setDiagnostics] = createSignal<PreviewDiagnostics>();
  const [projectId, setProjectId] = createSignal(newProjectId());
  const [revision, setRevision] = createSignal(0);
  const [dirty, setDirty] = createSignal(false);
  const [recent, setRecent] = createSignal<RecentProject[]>(() => {
    try {
      return recentProjects(
        JSON.parse(localStorage.getItem(recentProjectsKey) ?? "[]"),
      );
    } catch {
      return [];
    }
  });
  const [exportJob, setExportJob] = createSignal<ExportJob>();
  const [exportStatus, setExportStatus] = createSignal("");
  const [exportMode, setExportMode] = createSignal<"merge" | "separate">(
    "merge",
  );
  const [exportSelection, setExportSelection] = createSignal<
    "segments" | "gaps"
  >("segments");
  const [cutStrategy, setCutStrategy] = createSignal("stream_copy_preferred");
  const [streamIndexes, setStreamIndexes] = createSignal<number[]>([]);
  const [detectionJob, setDetectionJob] = createSignal<DetectionJob>();
  const [detectionStatus, setDetectionStatus] = createSignal("");
  const [detectionCandidates, setDetectionCandidates] = createSignal<
    Candidate[]
  >([]);
  const [timeline, setTimeline] = createSignal<TimelineHistory>(
    createTimelineHistory({
      playheadMs: 0,
      inMs: 0,
      outMs: 0,
      segments: [],
      zoom: 1,
    }),
  );
  let video: HTMLVideoElement | undefined;
  let mediaRequest: AbortController | undefined;
  let metadataRequest: AbortController | undefined;
  let metadataRequestVersion = 0;
  let assetRequest: AbortController | undefined;
  let previewRequest: AbortController | undefined;
  let cleanupPreview: (() => void) | undefined;
  let thumbnailObjectURL: string | undefined;
  let requestVersion = 0;
  let projectRequest: AbortController | undefined;
  let projectRequestVersion = 0;
  let refreshRequest: AbortController | undefined;
  let refreshRequestVersion = 0;
  let saveRequest: AbortController | undefined;
  let saveVersion = 0;
  let editorVersion = 0;
  let exportTimer: number | undefined;
  let exportRequest = 0;
  let detectionTimer: number | undefined;
  let detectionRequest = 0;
  let exportController: AbortController | undefined;
  let detectionController: AbortController | undefined;

  const present = () => timeline().present;
  const markDirty = () => {
    editorVersion++;
    setDirty(true);
  };
  const updateTimeline = (changes: Partial<ReturnType<typeof present>>) => {
    const next = editTimeline(timeline(), changes);
    setTimeline(next);
    setPlayheadMs(next.present.playheadMs);
    markDirty();
  };
  const loadMedia = async (cursor?: string, refreshed = false) => {
    mediaRequest?.abort();
    const controller = new AbortController();
    mediaRequest = controller;
    const request = ++requestVersion;
    if (cursor) setLoadingMore(true);
    else setStatus("Loading media…");
    try {
      const response = await api.request(
        `media?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        { signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(`Media request failed (${response.status}).`);
      const page = (await response.json()) as MediaPage;
      if (controller.signal.aborted || request !== requestVersion) return;
      setMedia(cursor ? [...media(), ...page.items] : page.items);
      setNextCursor(page.nextCursor ?? undefined);
      setStatus(
        refreshed
          ? "Media refreshed. Choose media to begin."
          : "Choose media to begin.",
      );
      if (refreshed && !cursor) {
        const current = selected();
        if (current && !page.items.some((item) => item.id === current.id)) {
          const metadata = await api.request(`media/${encodeURIComponent(current.id)}`, { signal: controller.signal });
          if (controller.signal.aborted || request !== requestVersion) return;
          if (metadata.ok) {
            const item = (await metadata.json()) as Media;
            if (controller.signal.aborted || request !== requestVersion || selected()?.id !== current.id) return;
            setSelected(item);
          } else if (metadata.status === 404) {
            setStatus("Selected media is no longer indexed. Unsaved project changes were kept.");
          }
        } else if (current) {
          const refreshedItem = page.items.find((item) => item.id === current.id);
          if (refreshedItem) setSelected(refreshedItem);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted && request === requestVersion)
        setStatus(
          error instanceof Error ? error.message : "Media request failed.",
        );
    } finally {
      if (request === requestVersion) setLoadingMore(false);
    }
  };
  const refreshMedia = async () => {
    mediaRequest?.abort();
    requestVersion++;
    metadataRequest?.abort();
    metadataRequestVersion++;
    refreshRequest?.abort();
    const controller = new AbortController();
    refreshRequest = controller;
    const request = ++refreshRequestVersion;
    setRefreshing(true);
    try {
      const response = await api.request("media/refresh", { method: "POST", signal: controller.signal });
      if (controller.signal.aborted || request !== refreshRequestVersion) return;
      if (response.status === 403) setStatus("You are not allowed to refresh media.");
      else if (response.status === 429) setStatus("Media refresh is already in progress. Try again shortly.");
      else if (!response.ok) setStatus("Media refresh failed. Try again.");
      else await loadMedia(undefined, true);
    } catch {
      if (!controller.signal.aborted && request === refreshRequestVersion)
        setStatus("Media refresh failed. Try again.");
    } finally {
      if (request === refreshRequestVersion) setRefreshing(false);
    }
  };
  const invalidateSaveContext = () => {
    saveRequest?.abort();
    saveRequest = undefined;
    saveVersion++;
    editorVersion++;
  };
  const clearExportContext = () => {
    exportController?.abort();
    exportController = undefined;
    exportRequest++;
    if (exportTimer) window.clearTimeout(exportTimer);
    exportTimer = undefined;
    setExportJob();
    setExportStatus("");
  };
  const chooseMedia = (item: Media) => {
    if (!confirmDiscard(dirty(), () => window.confirm("Discard unsaved changes?"))) return;
    clearExportContext();
    invalidateSaveContext();
    metadataRequest?.abort();
    const controller = new AbortController();
    metadataRequest = controller;
    const request = ++metadataRequestVersion;
    setSelected(item);
    setPlayheadMs(0);
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
    void api
      .request(`media/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`Metadata request failed (${response.status}).`);
        return response.json() as Promise<Media>;
      })
      .then((metadata) => {
        if (acceptsMediaMetadata(controller.signal.aborted, request, metadataRequestVersion, selected()?.id, metadata.id))
          setSelected(metadata);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted && request === metadataRequestVersion && selected()?.id === item.id)
          setStatus(error instanceof Error ? error.message : "Metadata request failed.");
      });
  };
  onSettled(() => {
    void loadMedia();
  });
  createEffect(
    () => selected(),
    (item) => {
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
      .assetRequest(item.id, "thumbnails", { startMs: 0, durationMs, count: 16, width: 320 }, { signal: controller.signal })
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
        if (!controller.signal.aborted) setAssetStatus("Thumbnails unavailable; editing remains available.");
      });
    void api
      .assetRequest(item.id, "waveform", { startMs: 0, durationMs, samples: 256 }, { signal: controller.signal })
      .then(async (response) => {
        const value = (await response.json()) as { peaks?: unknown };
        if (!response.ok) throw new Error();
        return normalizePeaks(value.peaks);
      })
      .then((peaks) => {
        if (!controller.signal.aborted) setWaveform(peaks);
      })
      .catch(() => {
        if (!controller.signal.aborted) setAssetStatus("Waveform unavailable; editing remains available.");
      });
    return () => controller.abort();
    },
  );
  createEffect(
    () => [selected(), playheadMs(), muted()] as const,
    ([item, position, isMuted]) => {
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
        () => api.request(`media/${encodeURIComponent(item.id)}/preview?${params}`, { signal: request.signal }),
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
    return () => {
      window.clearTimeout(timer);
      previewRequest?.abort();
      cleanupPreview?.();
      cleanupPreview = undefined;
    };
  });
  const watchedPosition = () => {
    const item = selected();
    const info = diagnostics();
    return item && info && video
      ? watchedMediaPosition(info.startMs, video.currentTime, item.durationMs)
      : playheadMs();
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
    return Array.isArray(value) ? value.filter((track): track is { index: number; type: string; codec: string } => !!track && typeof track === "object" && Number.isInteger((track as { index?: unknown }).index) && typeof (track as { type?: unknown }).type === "string" && typeof (track as { codec?: unknown }).codec === "string") : [];
  };
  createEffect(
    () => dirty(),
    (isDirty) => {
    if (!isDirty) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
    },
  );
  const removeSegment = (index: number) => updateTimeline({ segments: removeSegments(present().segments, index) });
  const moveSegment = (index: number, direction: -1 | 1) => updateTimeline({ segments: moveSegments(present().segments, index, direction) });
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
    if (!validProjectId(projectId()))
      return void setStatus("Project ID is invalid.");
    if (!item) return void setStatus("Select media before saving.");
    const error = validateSegments(present().segments, item.durationMs);
    if (error) return void setStatus(error);
    let response: Response;
    try {
      response = await api.request(
        `projects/${encodeURIComponent(snapshotProject)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
          mediaId: item.id,
          revision: revision(),
          segments: present().segments,
          uiState: {
            playheadMs: playheadMs(),
            zoom: present().zoom,
            muted: muted(),
          },
          }),
        },
      );
    } catch (error) {
      if (!controller.signal.aborted && request === saveVersion)
        setStatus(error instanceof Error ? error.message : "Project save failed.");
      return;
    }
    if (!saveIsCurrent(controller.signal.aborted, request, saveVersion, editorVersion, snapshotEditorVersion, snapshotProject, projectId(), snapshotMedia, selected()?.id)) return;
    if (response.status === 409) {
      setStatus(
        "Project changed on another client. Load latest before saving.",
      );
      return;
    }
    if (!response.ok) {
      setStatus(`Project save failed (${response.status}).`);
      return;
    }
    const project = (await response.json()) as Project;
    if (!saveIsCurrent(controller.signal.aborted, request, saveVersion, editorVersion, snapshotEditorVersion, snapshotProject, projectId(), snapshotMedia, selected()?.id)) return;
    setRevision(project.revision);
    setDirty(false);
    remember(project.id, item.name);
    setStatus(`Project saved (revision ${project.revision}).`);
    return project;
  };
  const loadProject = async (id = projectId()) => {
    if (!validProjectId(id)) return void setStatus("Project ID is invalid.");
    if (
      !confirmDiscard(dirty(), () => window.confirm("Discard unsaved changes?"))
    )
      return;
    clearExportContext();
    invalidateSaveContext();
    setDiagnostics();
    projectRequest?.abort();
    const controller = new AbortController();
    projectRequest = controller;
    const request = ++projectRequestVersion;
    try {
      const response = await api.request(`projects/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Project load failed (${response.status}).`);
      const project = (await response.json()) as Project;
      if (controller.signal.aborted || request !== projectRequestVersion) return;
      const mediaResponse = await api.request(
        `media/${encodeURIComponent(project.mediaId)}`,
        { signal: controller.signal },
      );
      if (!mediaResponse.ok)
        throw new Error(`Media request failed (${mediaResponse.status}).`);
      const item = (await mediaResponse.json()) as Media;
      if (controller.signal.aborted || request !== projectRequestVersion) return;
      setProjectId(project.id);
      setRevision(project.revision);
      setSelected(item);
      setMedia((items) =>
        items.some((known) => known.id === item.id) ? items : [...items, item],
      );
      setTimeline(
        createTimelineHistory({
          playheadMs: project.uiState.playheadMs,
          inMs: project.uiState.playheadMs,
          outMs: project.uiState.playheadMs,
          segments: project.segments,
          zoom: project.uiState.zoom,
        }),
      );
      setPlayheadMs(project.uiState.playheadMs);
      setMuted(project.uiState.muted);
      setDirty(false);
      remember(project.id, item.name);
      setStatus("Project loaded.");
    } catch (error) {
      if (!controller.signal.aborted && request === projectRequestVersion)
        setStatus(
          error instanceof Error ? error.message : "Project load failed.",
        );
    }
  };
  const newProject = () => {
    if (
      !confirmDiscard(dirty(), () => window.confirm("Discard unsaved changes?"))
    )
      return;
    clearExportContext();
    invalidateSaveContext();
    projectRequest?.abort();
    metadataRequest?.abort();
    ++projectRequestVersion;
    ++metadataRequestVersion;
    setProjectId(newProjectId());
    setRevision(0);
    setDirty(false);
    setSelected();
    setPlayheadMs(0);
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
    mediaRequest?.abort();
    refreshRequest?.abort();
    saveRequest?.abort();
    assetRequest?.abort();
    previewRequest?.abort();
    projectRequest?.abort();
    metadataRequest?.abort();
    cleanupPreview?.();
    if (thumbnailObjectURL) URL.revokeObjectURL(thumbnailObjectURL);
    if (exportTimer) window.clearTimeout(exportTimer);
    if (detectionTimer) window.clearTimeout(detectionTimer);
    requestVersion++;
    metadataRequestVersion++;
    projectRequestVersion++;
    refreshRequestVersion++;
    saveVersion++;
    exportRequest++;
    detectionRequest++;
    exportController?.abort();
    detectionController?.abort();
  });
  const exportFailure = exportFailureMessage;
  const exportProject = async () => {
    const saved = await saveProject();
    if (!saved) return;
    const request = ++exportRequest;
    exportController?.abort();
    const controller = new AbortController();
    exportController = controller;
    if (exportTimer) clearTimeout(exportTimer);
    setExportStatus("Starting export…");
    let response: Response;
    try {
      response = await api.request(
        `projects/${encodeURIComponent(saved.id)}/exports`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: exportMode(),
            selection: exportSelection(),
            streamIndexes: streamIndexes(),
            cutStrategy: cutStrategy(),
            container: "mkv",
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (controller.signal.aborted || request !== exportRequest) return;
      return setExportStatus(error instanceof Error ? error.message : "Export could not be started. Try again.");
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
    const poll = async () => {
      if (controller.signal.aborted || request !== exportRequest) return;
      let nextResponse: Response;
      try {
        nextResponse = await api.request(`jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted || request !== exportRequest) return;
        return setExportStatus(error instanceof Error ? error.message : "Export status could not be updated. Try again.");
      }
      if (controller.signal.aborted || request !== exportRequest) return;
      if (!nextResponse.ok)
        return setExportStatus(
          "Export status could not be updated. Try again.",
        );
      const next = (await nextResponse.json()) as ExportJob;
      if (controller.signal.aborted || request !== exportRequest) return;
      setExportJob(next);
      if (next.state === "queued" || next.state === "running") {
        setExportStatus(
          next.state === "queued" ? "Export queued." : "Export running.",
        );
        exportTimer = window.setTimeout(() => void poll(), 1000);
      } else
        setExportStatus(
          next.state === "succeeded"
            ? "Export complete."
            : next.state === "cancelled"
              ? "Export cancelled."
              : exportFailure(next.errorCode),
        );
    };
      setExportStatus(
      job.state === "queued" ? "Export queued." : job.state === "running" ? "Export running." : job.state === "succeeded" ? "Export complete." : job.state === "cancelled" ? "Export cancelled." : exportFailure(job.errorCode),
    );
    if (job.state === "queued" || job.state === "running")
      exportTimer = window.setTimeout(() => void poll(), 1000);
  };
  const cancelExport = async () => {
    const job = exportJob();
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    const request = ++exportRequest;
    exportController?.abort();
    if (exportTimer) clearTimeout(exportTimer);
    try {
      const response = await api.request(`jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      if (request !== exportRequest) return;
      if (!response.ok) throw new Error("Export could not be cancelled. Try again.");
      setExportJob({ ...job, state: "cancelled" });
      setExportStatus("Export cancelled.");
    } catch (error) {
      if (request === exportRequest) setExportStatus(error instanceof Error ? error.message : "Export could not be cancelled. Try again.");
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
      response = await api.request(
        `projects/${encodeURIComponent(saved.id)}/detections`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mediaId: saved.mediaId,
            projectRevision: saved.revision,
            kind,
          }),
          signal: controller.signal,
        },
      );
    } catch (error) {
      if (controller.signal.aborted || request !== detectionRequest) return;
      return setDetectionStatus(error instanceof Error ? error.message : "Detection could not be started.");
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
    const poll = async () => {
      if (controller.signal.aborted || request !== detectionRequest) return;
      let result: Response;
      try {
        result = await api.request(`jobs/${encodeURIComponent(job.id)}`, { signal: controller.signal });
      } catch (error) {
        if (controller.signal.aborted || request !== detectionRequest) return;
        return setDetectionStatus(error instanceof Error ? error.message : "Detection status could not be updated.");
      }
      if (controller.signal.aborted || request !== detectionRequest) return;
      if (!result.ok)
        return setDetectionStatus("Detection status could not be updated.");
      const next = (await result.json()) as DetectionJob;
      if (controller.signal.aborted || request !== detectionRequest) return;
      setDetectionJob(next);
      if (next.state === "queued" || next.state === "running") {
        setDetectionStatus(
          next.state === "queued" ? "Detection queued." : "Detection running.",
        );
        detectionTimer = window.setTimeout(() => void poll(), 500);
      } else if (next.state === "succeeded") {
        setDetectionCandidates(next.candidates ?? []);
        setDetectionStatus(
          `${next.candidates?.length ?? 0} candidates found. Review each before accepting.`,
        );
      } else
        setDetectionStatus(
          next.state === "cancelled"
            ? "Detection cancelled."
            : `Detection failed${next.errorCode ? `: ${next.errorCode}.` : "."}`,
        );
    };
    if (job.state === "queued" || job.state === "running")
      detectionTimer = window.setTimeout(() => void poll(), 500);
    else if (job.state === "succeeded") {
      setDetectionCandidates(job.candidates ?? []);
      setDetectionStatus(`${job.candidates?.length ?? 0} candidates found. Review each before accepting.`);
    } else if (job.state === "cancelled") setDetectionStatus("Detection cancelled.");
    else setDetectionStatus(`Detection failed${job.errorCode ? `: ${job.errorCode}.` : "."}`);
  };
  const cancelDetection = async () => {
    const job = detectionJob();
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    const request = ++detectionRequest;
    detectionController?.abort();
    if (detectionTimer) clearTimeout(detectionTimer);
    try {
      const response = await api.request(`jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      if (request !== detectionRequest) return;
      if (!response.ok) throw new Error("Detection could not be cancelled. Try again.");
      setDetectionJob({ ...job, state: "cancelled" });
      setDetectionStatus("Detection cancelled.");
    } catch (error) {
      if (request === detectionRequest) setDetectionStatus(error instanceof Error ? error.message : "Detection could not be cancelled. Try again.");
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
      return setDetectionStatus(
        "Candidate is stale, invalid, or overlaps an existing segment.",
      );
    updateTimeline({ segments: next.segments });
    markDirty();
    setDetectionCandidates((items) => items.filter((item) => item.id !== candidate.id));
    setDetectionStatus("Candidate accepted; save the project to persist it.");
  };
  onSettled(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement;
    if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const step = frameDuration(selected()) || 1000;
      updateTimeline({ playheadMs: Math.max(0, Math.min(duration(), playheadMs() + (event.key === "ArrowLeft" ? -step : step))) });
    } else if (event.key === " ") {
      event.preventDefault();
      if (video?.paused) void video.play(); else video?.pause();
    } else if (event.key.toLowerCase() === "i") {
      event.preventDefault(); setMarker("inMs", watchedPosition());
    } else if (event.key.toLowerCase() === "o") {
      event.preventDefault(); setMarker("outMs", watchedPosition());
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      const next = event.shiftKey ? redoTimeline(timeline()) : undoTimeline(timeline());
      setTimeline(next); setPlayheadMs(next.present.playheadMs); markDirty();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      event.preventDefault();
      const next = redoTimeline(timeline()); setTimeline(next); setPlayheadMs(next.present.playheadMs); markDirty();
    }
  };
  return (
    <main aria-label="VideoCutlist segment selection">
      <header>
        <h1>VideoCutlist</h1>
        <p role="status" aria-live="polite">
          {status()}
        </p>
      </header>
      <section aria-labelledby="media-heading">
        <h2 id="media-heading">Media</h2>
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
                    {formatTime(item.durationMs, item.durationMs)} ·{" "}
                    {item.container}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={nextCursor()}>
          <button
            disabled={loadingMore()}
            onClick={() => void loadMedia(nextCursor())}
          >
            {loadingMore() ? "Loading more…" : "Load more"}
          </button>
        </Show>
        <button disabled={refreshing()} onClick={() => void refreshMedia()}>
          {refreshing() ? "Refreshing media…" : "Refresh media"}
        </button>
      </section>
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Timeline</h2>
        <Show when={selected()} fallback={<p>Select a media item.</p>}>
          {(item) => (
            <>
              <p>
                <strong>{item().name}</strong> ·{" "}
                {formatTime(item().durationMs, duration())}
              </p>
              <p id="timeline-description">
                Playhead {formatTime(playheadMs(), duration())}. In marker{" "}
                {formatTime(present().inMs, duration())}. Out marker{" "}
                {formatTime(present().outMs, duration())}.{" "}
{present().segments.length
                  ? `${present().segments.length} segment${present().segments.length === 1 ? "" : "s"} selected.`
                  : "No segments selected."}
              </p>
              <div
                class="timeline-visual"
                role="group"
                aria-labelledby="timeline-heading timeline-description"
                style={{ width: `${viewportScale(present().zoom) * 100}%` }}
              >
                <TimelineCanvas
                  thumbnailURL={thumbnailURL()}
                  waveform={waveform()}
                />
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
              <p>In: {formatTime(present().inMs, duration())} · Out: {formatTime(present().outMs, duration())}</p>
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
                    setPlayheadMs(next.present.playheadMs);
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
                    setPlayheadMs(next.present.playheadMs);
                    markDirty();
                  }}
                >
                  Redo
                </button>
                <button onClick={addSegment}>Add In/Out segment</button>
                <button onClick={() => setMarker("inMs", watchedPosition())}>Set In marker</button>
                <button onClick={() => setMarker("outMs", Math.min(duration(), watchedPosition()))}>Set Out marker</button>
                <label>Timecode <input value={timecode()} placeholder="0:00.000" onInput={(event) => setTimecode(event.currentTarget.value)} /></label>
                <button onClick={() => { const value = parseTimecode(timecode()); if (value === undefined || value > duration()) return setStatus("Invalid timecode."); updateTimeline({ playheadMs: value }); }}>Go to timecode</button>
                <label>Segment label <input value={segmentLabel()} onInput={(event) => setSegmentLabel(event.currentTarget.value)} /></label>
              </div>
              <ol aria-label="Selected segments">
                <For each={present().segments}>
                  {(segment, index) => <li>{segment.label ?? "Unlabelled"}: <span>{formatTime(segment.startMs, duration())} – {formatTime(segment.endMs, duration())}</span> <button onClick={() => moveSegment(index(), -1)} disabled={index() === 0}>↑</button> <button onClick={() => moveSegment(index(), 1)} disabled={index() === present().segments.length - 1}>↓</button> <button onClick={() => removeSegment(index())}>Remove</button></li>}
                </For>
              </ol>
              <Show when={canStreamPreview()} fallback={<p role="status">Preview is unavailable in this browser. Use the timeline controls to set markers manually.</p>}>
                <video
                  ref={(element) => {
                    video = element;
                  }}
                  controls
                  muted={muted()}
                  aria-label="Preview player"
                  data-preview-offset={diagnostics()?.offsetMs ?? 0}
                />
              </Show>
              <section aria-labelledby="diagnostics-heading">
                <h2 id="diagnostics-heading">Preview diagnostics</h2>
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
                  <dd>{diagnostics() ? `${diagnostics()!.startMs} ms / ${diagnostics()!.durationMs} ms` : "—"}</dd>
                  <dt>Response</dt>
                  <dd>{diagnostics() ? `${diagnostics()!.elapsedMs} ms` : "—"}</dd>
                </dl>
              </section>
              <label>
                <input
                  type="checkbox"
                  checked={muted()}
                  onChange={(event) => { setMuted(event.currentTarget.checked); markDirty(); }}
                />{" "}
                Mute preview
              </label>
            </>
          )}
        </Show>
      </section>
      <section aria-labelledby="project-heading">
        <h2 id="project-heading">Project</h2>
        <label>
          Project ID{" "}
          <input
            value={projectId()}
            onInput={(event) => { setProjectId(event.currentTarget.value); markDirty(); }}
          />
        </label>
        <p>
          Revision {revision()} {dirty() ? "· unsaved changes" : "· saved"}
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
                      throw new Error(
                        "Select the cut list's media before importing.",
                      );
                    const segments = imported.segments as Segment[];
                    const error = validateSegments(
                      segments,
                      selected()!.durationMs,
                    );
                    if (error) throw new Error(error);
                    updateTimeline({ segments });
                    markDirty();
                    setStatus(
                      "Cut list imported. Save the project to keep it.",
                    );
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
          <label>
            Import CSV or chapters{" "}
            <input
              type="file"
              accept=".csv,.txt,text/csv,text/plain"
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (!file || file.size > 1 << 20) {
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
                        "Content-Type":
                          format === "csv" ? "text/csv" : "text/plain",
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
          <button
            onClick={() =>
              void api
                .interchangeRequest(projectId(), "csv")
                .then((response) =>
                  response.ok ? response.blob() : Promise.reject(),
                )
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
            onClick={() =>
              void api
                .interchangeRequest(projectId(), "chapters")
                .then((response) =>
                  response.ok ? response.blob() : Promise.reject(),
                )
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
      </section>
      <section aria-labelledby="export-heading">
        <h2 id="export-heading">Export</h2>
        <p role="status">{exportStatus() || "Export a saved project."}</p>
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
              setExportSelection(
                event.currentTarget.value as "segments" | "gaps",
              )
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
              const checked = () => streamIndexes().length === 0 || streamIndexes().includes(track.index);
              return <label>
                <input type="checkbox" checked={checked()} onChange={(event) => {
                  const all = streamIndexes().length ? streamIndexes() : tracks().map((item) => item.index);
                  setStreamIndexes(event.currentTarget.checked ? [...new Set([...all, track.index])] : all.filter((index) => index !== track.index));
                }} /> {track.type} {track.codec} (#{track.index})
              </label>;
            }}
          </For>
        </fieldset>
        <label>
          Cut strategy{" "}
          <select
            value={cutStrategy()}
            onChange={(event) => setCutStrategy(event.currentTarget.value)}
          >
            <option value="stream_copy_preferred">Stream copy preferred</option>
            <option value="precise_reencode">Precise re-encode</option>
            <option value="hybrid_smart_cut" disabled={hybridSmartCutKnownIneligible(selected())}>Hybrid smart cut{hybridSmartCutKnownIneligible(selected()) ? " (unavailable)" : ""}</option>
          </select>
        </label>
        <div class="controls">
          <button disabled={!selected() || !present().segments.length} onClick={() => void exportProject()}>
            Start export
          </button>
          <Show
            when={
              exportJob()?.state === "queued" ||
              exportJob()?.state === "running"
            }
          >
            <button onClick={() => void cancelExport()}>Cancel export</button>
          </Show>
        </div>
        <Show when={exportJob()?.result}>
          <div>
            <div aria-label="Export result"><p>Output ready: {exportJob()!.result!.outputName ?? exportJob()!.result!.outputNames?.join(", ")}</p>
            <p>{exportJob()!.result!.sizeBytes.toLocaleString()} bytes · retained until {exportJob()!.result!.retainUntil}</p></div>
            <div aria-label="Export warnings"><For each={exportJob()!.warnings ?? []}>{(warning) => <p role="status">Warning: {warning}</p>}</For></div>
          </div>
        </Show>
      </section>
      <section aria-labelledby="detection-heading">
        <h2 id="detection-heading">Auto detection</h2>
        <p role="status">
          {detectionStatus() ||
            "Review candidates before they change segments."}
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
              detectionJob()?.state === "queued" ||
              detectionJob()?.state === "running"
            }
          >
            <button onClick={() => void cancelDetection()}>
              Cancel detection
            </button>
          </Show>
        </div>
        <Show when={detectionCandidates().length > 0}>
          <ol aria-label="Detection candidates">
            <For each={detectionCandidates()}>
              {(candidate) => (
                <li>
                  {candidate.source} ·{" "}
                  {formatTime(candidate.startMs, duration())}–
                  {formatTime(candidate.endMs, duration())} ·{" "}
                  {Math.round(candidate.confidence * 100)}%{" "}
                  <button onClick={() => acceptDetection(candidate)}>
                    Accept
                  </button>
                  <button
                    onClick={() => {
                      setDetectionCandidates(
                        detectionCandidates().filter(
                          (item) => item.id !== candidate.id,
                        ),
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
      </section>
    </main>
  );
}
