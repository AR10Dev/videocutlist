import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  createApiClient,
  resolveBrowserConfiguration,
  validInterchangeFileSize,
} from "./api";
import { normalizePeaks, viewportScale } from "./assets";
import { acceptCandidate, type Candidate, type DetectionKind } from "./detection";
import {
  canStreamPreview,
  formatTime,
  hybridSmartCutKnownIneligible,
  streamPreview,
  validateSegments,
  watchedMediaPosition,
  type Media,
  type PreviewDiagnostics,
  type Segment,
} from "./preview";
import {
  confirmDiscard,
  newProjectId,
  parseProjectJson,
  projectJson,
  recentProjects,
  recentProjectsKey,
  type RecentProject,
  validProjectId,
} from "./projectLifecycle";
import {
  createTimelineHistory,
  editTimeline,
  redoTimeline,
  resetTimelineHistory,
  undoTimeline,
} from "./timeline";
type Project = {
  id: string;
  mediaId: string;
  revision: number;
  segments: Segment[];
  uiState: { playheadMs: number; zoom: number; muted: boolean };
};

type DetectionJob = {
  id: string;
  type: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  mediaId: string;
  projectId: string;
  projectRevision: number;
  kind: DetectionKind;
  candidates?: Candidate[];
  errorCode?: string;
};

type ExportJob = {
  id: string;
  type: string;
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

type MediaPage = { items: Media[]; nextCursor?: string | null };

const api = createApiClient(resolveBrowserConfiguration());

const mediaDuration = (media?: Media) => media?.durationMs ?? 0;

type Track = { index: number; type: string; codec: string };

const tracks = (media?: Media): Track[] => {
  const value = media?.streams.tracks;
  return Array.isArray(value)
    ? value.filter(
        (track): track is Track =>
          !!track &&
          typeof track === "object" &&
          Number.isInteger((track as Track).index) &&
          typeof (track as Track).type === "string" &&
          typeof (track as Track).codec === "string",
      )
    : [];
};

const parseTimecode = (value: string) => {
  const match = /^(\d+):(\d{2})\.(\d{3})$/.exec(value.trim());
  if (!match || Number(match[2]) > 59) return undefined;
  return Number(match[1]) * 60_000 + Number(match[2]) * 1000 + Number(match[3]);
};

const frameDuration = (media?: Media) => {
  const rate = media?.streams.video as { avgFrameRate?: string } | undefined;
  const [numerator, denominator] = rate?.avgFrameRate?.split("/") ?? [];
  const fps = Number(numerator) / Number(denominator);
  return Number.isFinite(fps) && fps > 0
    ? Math.max(1, Math.round(1000 / fps))
    : 0;
};

const exportFailures: Record<string, string> = {
  interrupted_by_restart:
    "Export was interrupted by a server restart. Try again.",
  invalid_export_request: "Export request was invalid. Try again.",
  media_unavailable:
    "Selected media is unavailable. Choose media and try again.",
  export_failed: "Export failed. Try again.",
  hybrid_smart_cut_unsupported_media:
    "Hybrid Smart Cut is unavailable for this file. It supports H.264 constant-frame-rate video in MKV only. Use Stream Copy or Precise Re-encode instead.",
  result_encoding_failed:
    "Export failed while preparing its result. Try again.",
};

const exportFailure = (code?: string) =>
  exportFailures[code ?? ""] ?? "Export failed. Try again.";

type EditorState = {
  selected?: Media;
  playheadMs: number;
  segments: Segment[];
  inMs: number;
  outMs: number;
  segmentLabel: string;
  projectId: string;
  revision: number;
  zoom: number;
  muted: boolean;
  diagnostics?: PreviewDiagnostics;
  dirty: boolean;
};

type EditorAction = { type: "change"; changes: Partial<EditorState> };

const editorReducer = (
  state: EditorState,
  action: EditorAction,
): EditorState => ({
  ...state,
  ...action.changes,
});

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const selectionRef = useRef(0);
  const exportRequestRef = useRef(0);
  const exportTimerRef = useRef<number | undefined>(undefined);
  const detectionTimerRef = useRef<number | undefined>(undefined);
  const detectionRequestRef = useRef(0);
  const loadRequestRef = useRef<AbortController | undefined>(undefined);
  const editorRequestsRef = useRef({
    editor: 0,
    load: 0,
    save: 0,
    metadata: 0,
  });
  const mediaRequestRef = useRef<AbortController | undefined>(undefined);
  const mediaRequestVersionRef = useRef(0);
  const refreshRequestRef = useRef<AbortController | undefined>(undefined);
  const refreshRequestVersionRef = useRef(0);
  const metadataRequestRef = useRef<AbortController | undefined>(undefined);
  const assetRequestRef = useRef<AbortController | undefined>(undefined);
  const [thumbnailURL, setThumbnailURL] = useState<string>();
  const thumbnailURLRef = useRef<string | undefined>(undefined);
  const [waveform, setWaveform] = useState<number[]>([]);
  const [assetStatus, setAssetStatus] = useState("");
  const selectedRef = useRef<Media | undefined>(undefined);
  const [media, setMedia] = useState<Media[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshingMedia, setRefreshingMedia] = useState(false);
  const [editor, dispatchEditor] = useReducer(editorReducer, undefined, () => ({
    selected: undefined,
    playheadMs: 0,
    segments: [],
    inMs: 0,
    outMs: 0,
    segmentLabel: "",
    projectId: newProjectId(),
    revision: 0,
    zoom: 1,
    muted: false,
    diagnostics: undefined,
    dirty: false,
  }));
  const {
    selected,
    playheadMs,
    segments,
    inMs,
    outMs,
    segmentLabel,
    projectId,
    revision,
    zoom,
    muted,
    diagnostics,
    dirty,
  } = editor;
  const initialTimelineHistory = createTimelineHistory({
    playheadMs,
    inMs,
    outMs,
    segments,
    zoom,
  });
  const timelineHistoryRef = useRef(initialTimelineHistory);
  const [timelineHistory, setTimelineHistory] = useState(initialTimelineHistory);
  const projectIdRef = useRef(projectId);
  const editorRef = useRef(editor);
  const [status, setStatus] = useState("Loading media…");
  const [exportJob, setExportJob] = useState<ExportJob>();
  const [detectionJob, setDetectionJob] = useState<DetectionJob>();
  const [detectionStatus, setDetectionStatus] = useState("");
  const [detectionCandidates, setDetectionCandidates] = useState<Candidate[]>([]);
  const [exportStatus, setExportStatus] = useState("");
  const [exportMode, setExportMode] = useState<"merge" | "separate">("merge");
  const [exportSelection, setExportSelection] = useState<"segments" | "gaps">(
    "segments",
  );
  const [cutStrategy, setCutStrategy] = useState<
    "stream_copy_preferred" | "precise_reencode" | "hybrid_smart_cut"
  >("stream_copy_preferred");
  const [streamIndexes, setStreamIndexes] = useState<number[]>([]);
  const hybridSmartCutUnavailable = hybridSmartCutKnownIneligible(selected);
  const [recent, setRecent] = useState<RecentProject[]>(() => {
    try {
      return recentProjects(
        JSON.parse(localStorage.getItem(recentProjectsKey) ?? "[]"),
      );
    } catch {
      return [];
    }
  });
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    const requestVersions = editorRequestsRef.current;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      cleanupRef.current?.();
      loadRequestRef.current?.abort();
      mediaRequestRef.current?.abort();
      refreshRequestRef.current?.abort();
      metadataRequestRef.current?.abort();
      assetRequestRef.current?.abort();
      if (thumbnailURLRef.current) URL.revokeObjectURL(thumbnailURLRef.current);
      if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
      selectionRef.current += 1;
      exportRequestRef.current += 1;
      requestVersions.load += 1;
      requestVersions.editor += 1;
      requestVersions.save += 1;
      mediaRequestVersionRef.current += 1;
      refreshRequestVersionRef.current += 1;
      requestVersions.metadata += 1;
    };
  }, []);

  useEffect(() => {
    editorRef.current = editor;
    selectedRef.current = selected;
    projectIdRef.current = projectId;
  }, [editor, projectId, selected]);

  const invalidateEditor = useCallback(() => {
    editorRequestsRef.current.editor += 1;
    loadRequestRef.current?.abort();
    metadataRequestRef.current?.abort();
    editorRequestsRef.current.metadata += 1;
  }, []);

  const changeEditor = useCallback(
    (changes: Partial<EditorState>, invalidate = false, recordTimeline = true) => {
      if (invalidate) invalidateEditor();
      const action: EditorAction = { type: "change", changes };
      const previous = editorRef.current;
      const next = editorReducer(previous, action);
      if (
        recordTimeline &&
        (changes.playheadMs !== undefined ||
          changes.inMs !== undefined ||
          changes.outMs !== undefined ||
          changes.segments !== undefined ||
          changes.zoom !== undefined)
      ) {
        const history = editTimeline(timelineHistoryRef.current, {
          playheadMs: next.playheadMs,
          inMs: next.inMs,
          outMs: next.outMs,
          segments: next.segments,
          zoom: next.zoom,
        });
        timelineHistoryRef.current = history;
        setTimelineHistory(history);
      }
      editorRef.current = next;
      dispatchEditor(action);
    },
    [invalidateEditor],
  );
  const setSelected = useCallback(
    (value: Media | undefined) => changeEditor({ selected: value }),
    [changeEditor],
  );
  const setPlayheadMs = useCallback(
    (value: number | ((current: number) => number)) =>
      changeEditor({
        playheadMs:
          typeof value === "function"
            ? value(editorRef.current.playheadMs)
            : value,
      }),
    [changeEditor],
  );
  const setSegments = useCallback(
    (value: Segment[] | ((current: Segment[]) => Segment[])) =>
      changeEditor({
        segments:
          typeof value === "function"
            ? value(editorRef.current.segments)
            : value,
      }),
    [changeEditor],
  );
  const setInMs = useCallback(
    (value: number) => changeEditor({ inMs: value }),
    [changeEditor],
  );
  const setOutMs = useCallback(
    (value: number) => changeEditor({ outMs: value }),
    [changeEditor],
  );
  const setSegmentLabel = useCallback(
    (value: string) => changeEditor({ segmentLabel: value }),
    [changeEditor],
  );
  const setProjectId = useCallback(
    (value: string) => changeEditor({ projectId: value }),
    [changeEditor],
  );
  const setRevision = useCallback(
    (value: number) => changeEditor({ revision: value }),
    [changeEditor],
  );
  const setDiagnostics = useCallback(
    (value: PreviewDiagnostics | undefined) =>
      changeEditor({ diagnostics: value }),
    [changeEditor],
  );
  const setZoom = useCallback(
    (value: number) => changeEditor({ zoom: value }),
    [changeEditor],
  );
  const setMuted = useCallback(
    (value: boolean) => changeEditor({ muted: value }),
    [changeEditor],
  );
  const setDirty = useCallback(
    (value: boolean) => changeEditor({ dirty: value }),
    [changeEditor],
  );
  const resetTimeline = useCallback(() => {
    const current = editorRef.current;
    const history = resetTimelineHistory({
      playheadMs: current.playheadMs,
      inMs: current.inMs,
      outMs: current.outMs,
      segments: current.segments,
      zoom: current.zoom,
    });
    timelineHistoryRef.current = history;
    setTimelineHistory(history);
  }, []);
  const applyTimelineHistory = useCallback(
    (operation: typeof undoTimeline) => {
      const next = operation(timelineHistoryRef.current);
      if (next === timelineHistoryRef.current) return;
      timelineHistoryRef.current = next;
      setTimelineHistory(next);
      invalidateEditor();
      changeEditor(next.present, false, false);
      setDirty(true);
      setStatus("Timeline history updated.");
    },
    [changeEditor, invalidateEditor, setDirty],
  );
  const undo = useCallback(
    () => applyTimelineHistory(undoTimeline),
    [applyTimelineHistory],
  );
  const redo = useCallback(
    () => applyTimelineHistory(redoTimeline),
    [applyTimelineHistory],
  );

  const rememberProject = useCallback(
    (id: string, label: string) => {
      if (!validProjectId(id)) return;
      const next = recentProjects([
        { id, label: label.slice(0, 120) || id, lastOpened: Date.now() },
        ...recent,
      ]);
      setRecent(next);
      try {
        localStorage.setItem(recentProjectsKey, JSON.stringify(next));
      } catch {
        // Storage is optional and untrusted.
      }
    },
    [recent],
  );

  const clearExport = useCallback(() => {
    exportRequestRef.current += 1;
    if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
    setExportJob(undefined);
    setExportStatus("");
  }, []);

  const clearAssetState = useCallback(() => {
    assetRequestRef.current?.abort();
    if (thumbnailURLRef.current) {
      URL.revokeObjectURL(thumbnailURLRef.current);
      thumbnailURLRef.current = undefined;
    }
    setThumbnailURL(undefined);
    setWaveform([]);
    setAssetStatus("");
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const chooseMedia = useCallback(
    (item: Media) => {
      if (
        !confirmDiscard(dirty, () => window.confirm("Discard unsaved changes?"))
      )
        return;
      clearExport();
      invalidateEditor();
      clearAssetState();
      selectedRef.current = item;
      setSelected(item);
      setPlayheadMs(0);
      setInMs(0);
      setOutMs(0);
      setSegments([]);
      setDiagnostics(undefined);
      setDirty(true);
      resetTimeline();
      setStatus(`Selected ${item.name}.`);
      const controller = new AbortController();
      metadataRequestRef.current = controller;
      const request = ++editorRequestsRef.current.metadata;
      void api
        .request(`media/${encodeURIComponent(item.id)}`, {
          signal: controller.signal,
        })
        .then((response) =>
          response.ok
            ? (response.json() as Promise<Media>)
            : Promise.reject(
                new Error(`Metadata request failed (${response.status}).`),
              ),
        )
        .then((metadata) => {
          if (
            mountedRef.current &&
            !controller.signal.aborted &&
            request === editorRequestsRef.current.metadata &&
            selectedRef.current?.id === metadata.id
          ) {
            selectedRef.current = metadata;
            setSelected(metadata);
          }
        })
        .catch((error: unknown) => {
          if (
            mountedRef.current &&
            !controller.signal.aborted &&
            request === editorRequestsRef.current.metadata &&
            selectedRef.current?.id === item.id
          )
            setStatus(
              error instanceof Error
                ? error.message
                : "Metadata request failed.",
            );
        });
    },
    [
      clearExport,
      dirty,
      invalidateEditor,
      setDiagnostics,
      setDirty,
      resetTimeline,
      clearAssetState,
      setInMs,
      setOutMs,
      setPlayheadMs,
      setSegments,
      setSelected,
    ],
  );

  const loadMedia = useCallback(
    async (cursor?: string, refreshed = false) => {
      mediaRequestRef.current?.abort();
      const controller = new AbortController();
      mediaRequestRef.current = controller;
      const request = ++mediaRequestVersionRef.current;
      if (cursor) setLoadingMore(true);
      const query = new URLSearchParams({ limit: "50" });
      if (cursor) query.set("cursor", cursor);
      try {
        const response = await api
          .request(`media?${query}`, { signal: controller.signal })
          .then((response) =>
            response.ok
              ? response.json()
              : Promise.reject(
                  new Error(`Media request failed (${response.status}).`),
                ),
          );
        const page = (await response) as MediaPage;
        if (!mountedRef.current || request !== mediaRequestVersionRef.current)
          return;
        setNextCursor(page.nextCursor || null);
        if (cursor) {
          setMedia((current) => [
            ...current,
            ...page.items.filter(
              (item) => !current.some((known) => known.id === item.id),
            ),
          ]);
        } else {
          setMedia(page.items);
          setStatus(
            page.items.length
              ? refreshed
                ? "Media refreshed. Choose media to begin."
                : "Choose media to begin."
              : "No media found.",
          );
          const selectedItem = selectedRef.current;
          if (refreshed && selectedItem) {
            const item = page.items.find(
              (candidate) => candidate.id === selectedItem.id,
            );
            if (item) {
              clearAssetState();
              setSelected(item);
            } else {
              const metadata = await api.request(
                `media/${encodeURIComponent(selectedItem.id)}`,
                { signal: controller.signal },
              );
              if (
                !mountedRef.current ||
                request !== mediaRequestVersionRef.current ||
                controller.signal.aborted
              )
                return;
              if (metadata.ok) {
                const item = (await metadata.json()) as Media;
                if (
                  mountedRef.current &&
                  selectedRef.current?.id === selectedItem.id &&
                  request === mediaRequestVersionRef.current
                )
                  clearAssetState();
                  setSelected(item);
                } else if (metadata.status === 404)
                if (
                  mountedRef.current &&
                  selectedRef.current?.id === selectedItem.id
                )
                  setStatus(
                    "Selected media is no longer indexed. Unsaved project changes were kept.",
                  );
            }
          }
        }
      } catch (error) {
        if (
          mountedRef.current &&
          !controller.signal.aborted &&
          request === mediaRequestVersionRef.current &&
          !cursor
        )
          setStatus(
            error instanceof Error ? error.message : "Unable to load media.",
          );
      } finally {
        if (
          mountedRef.current &&
          request === mediaRequestVersionRef.current &&
          cursor
        )
          setLoadingMore(false);
      }
    },
    [clearAssetState, setSelected],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void loadMedia(), 0);
    return () => {
      window.clearTimeout(timer);
      mediaRequestRef.current?.abort();
    };
  }, [loadMedia]);

  const refreshMedia = async () => {
    if (!mountedRef.current) return;
    mediaRequestRef.current?.abort();
    metadataRequestRef.current?.abort();
    editorRequestsRef.current.metadata += 1;
    refreshRequestRef.current?.abort();
    const controller = new AbortController();
    refreshRequestRef.current = controller;
    const request = ++refreshRequestVersionRef.current;
    setRefreshingMedia(true);
    try {
      const response = await api.request("media/refresh", {
        method: "POST",
        signal: controller.signal,
      });
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        request !== refreshRequestVersionRef.current
      )
        return;
      if (response.status === 403)
        setStatus("You are not allowed to refresh media.");
      else if (response.status === 429)
        setStatus("Media refresh is already in progress. Try again shortly.");
      else if (!response.ok) setStatus("Media refresh failed. Try again.");
      else await loadMedia(undefined, true);
    } catch {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        request === refreshRequestVersionRef.current
      )
        setStatus("Media refresh failed. Try again.");
    } finally {
      if (mountedRef.current && request === refreshRequestVersionRef.current)
        setRefreshingMedia(false);
    }
  };

  useEffect(() => {
    if (!selected) {
      return;
    }
    if (!canStreamPreview()) return;
    const timer = window.setTimeout(() => {
      const request = ++selectionRef.current;
      abortRef.current?.abort();
      cleanupRef.current?.();
      const controller = new AbortController();
      abortRef.current = controller;
      const video = videoRef.current;
      if (!video) return;
      setStatus("Loading preview…");
      const params = new URLSearchParams({
        centerMs: String(Math.round(playheadMs)),
        beforeMs: "2000",
        afterMs: "6000",
        mute: String(muted),
      });
      try {
        cleanupRef.current = streamPreview(
          video,
          () =>
            api.request(
              `media/${encodeURIComponent(selected.id)}/preview?${params}`,
              { signal: controller.signal },
            ),
          (next) => {
            if (
              !mountedRef.current ||
              request !== selectionRef.current ||
              controller.signal.aborted
            )
              return;
            setDiagnostics(next);
            setStatus("Preview ready.");
          },
          (error) => {
            if (
              !mountedRef.current ||
              request !== selectionRef.current ||
              controller.signal.aborted
            )
              return;
            setDiagnostics(undefined);
            setStatus(error.message);
          },
        );
      } catch (error) {
        if (mountedRef.current && !controller.signal.aborted)
          setStatus(error instanceof Error ? error.message : "Preview failed.");
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
      cleanupRef.current?.();
    };
  }, [muted, playheadMs, selected, setDiagnostics]);

  const markerPosition = useCallback(
    () =>
      diagnostics && videoRef.current
        ? watchedMediaPosition(
            diagnostics.startMs,
            videoRef.current.currentTime,
            mediaDuration(selected),
          )
        : playheadMs,
    [diagnostics, playheadMs, selected],
  );

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const editingText =
        (event.target instanceof HTMLInputElement &&
          event.target.type !== "range") ||
        event.target instanceof HTMLTextAreaElement;
      const modifier = event.metaKey || event.ctrlKey;
      if (modifier && !editingText && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (modifier && !editingText && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
        return;
      }
      if (editingText || !selected) return;
      if (event.key === "i" || event.key === "I") {
        event.preventDefault();
        invalidateEditor();
        setInMs(markerPosition());
        setDirty(true);
      }
      if (event.key === "o" || event.key === "O") {
        event.preventDefault();
        invalidateEditor();
        setOutMs(markerPosition());
        setDirty(true);
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        invalidateEditor();
        setPlayheadMs((value) =>
          Math.max(
            0,
            Math.min(
              selected.durationMs,
              value + (event.key === "ArrowLeft" ? -1000 : 1000),
            ),
          ),
        );
        setDirty(true);
      }
      if (event.key === " ") {
        event.preventDefault();
        void (videoRef.current?.paused
          ? videoRef.current.play()
          : videoRef.current?.pause());
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [
    invalidateEditor,
    markerPosition,
    playheadMs,
    selected,
    setDirty,
    setInMs,
    setOutMs,
    setPlayheadMs,
    redo,
    undo,
  ]);

  const addSegment = () => {
    const next = [
      ...segments,
      { startMs: inMs, endMs: outMs, label: segmentLabel || undefined },
    ];
    const error = validateSegments(next, mediaDuration(selected));
    if (error) return setStatus(error);
    invalidateEditor();
    setSegments(next);
    setSegmentLabel("");
    setDirty(true);
    setStatus("Segment added.");
  };

  const loadProject = async (id = projectId) => {
    if (!validProjectId(id)) {
      setStatus("Project ID is invalid.");
      return;
    }
    if (
      !confirmDiscard(dirty, () => window.confirm("Discard unsaved changes?"))
    )
      return;
    invalidateEditor();
    loadRequestRef.current?.abort();
    const controller = new AbortController();
    loadRequestRef.current = controller;
    const request = ++editorRequestsRef.current.load;
    const editorVersion = editorRequestsRef.current.editor;
    try {
      const response = await api.request(`projects/${encodeURIComponent(id)}`, {
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Project load failed (${response.status}).`);
      const project = (await response.json()) as Project;
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        request !== editorRequestsRef.current.load ||
        editorVersion !== editorRequestsRef.current.editor
      )
        return;
      if (!validProjectId(project.id) || !project.mediaId)
        throw new Error("Project load returned invalid data.");
      const mediaResponse = await api.request(
        `media/${encodeURIComponent(project.mediaId)}`,
        { signal: controller.signal },
      );
      if (!mediaResponse.ok)
        throw new Error(`Media request failed (${mediaResponse.status}).`);
      const item = (await mediaResponse.json()) as Media;
      if (item.id !== project.mediaId)
        throw new Error("Project media did not match the loaded project.");
      if (
        !mountedRef.current ||
        controller.signal.aborted ||
        request !== editorRequestsRef.current.load ||
        editorVersion !== editorRequestsRef.current.editor
      )
        return;
      clearExport();
      clearAssetState();
      projectIdRef.current = project.id;
      selectedRef.current = item;
      setProjectId(project.id);
      setRevision(project.revision);
      setSegments(project.segments);
      setPlayheadMs(project.uiState.playheadMs);
      setInMs(project.uiState.playheadMs);
      setOutMs(project.uiState.playheadMs);
      setSegmentLabel("");
      setZoom(project.uiState.zoom);
      setMuted(project.uiState.muted);
      setSelected(item);
      setMedia((current) =>
        current.some((candidate) => candidate.id === item.id)
          ? current
          : [...current, item],
      );
      setDiagnostics(undefined);
      setDirty(false);
      resetTimeline();
      rememberProject(project.id, item.name);
      setStatus("Project loaded.");
    } catch (error) {
      if (
        mountedRef.current &&
        !controller.signal.aborted &&
        request === editorRequestsRef.current.load &&
        editorVersion === editorRequestsRef.current.editor
      )
        setStatus(
          error instanceof Error ? error.message : "Project load failed.",
        );
    }
  };

  const newProject = () => {
    if (
      !confirmDiscard(dirty, () => window.confirm("Discard unsaved changes?"))
    )
      return;
    invalidateEditor();
    clearExport();
    clearAssetState();
    selectedRef.current = undefined;
    const id = newProjectId();
    projectIdRef.current = id;
    setProjectId(id);
    setRevision(0);
    setSelected(undefined);
    setSegments([]);
    setPlayheadMs(0);
    setInMs(0);
    setOutMs(0);
    setSegmentLabel("");
    setZoom(1);
    setMuted(false);
    setDiagnostics(undefined);
    setDirty(false);
    resetTimeline();
    setStatus("New project ready.");
  };

  const saveProject = async (): Promise<Project | undefined> => {
    if (!validProjectId(projectId)) {
      setStatus("Project ID is invalid.");
      return undefined;
    }
    if (!selected) {
      setStatus("Select media before saving.");
      return undefined;
    }
    const error = validateSegments(segments, selected.durationMs);
    if (error) {
      setStatus(error);
      return undefined;
    }
    const snapshot = {
      editorVersion: editorRequestsRef.current.editor,
      request: ++editorRequestsRef.current.save,
      id: projectId,
      revision,
      mediaId: selected.id,
    };
    try {
      const response = await api.request(
        `projects/${encodeURIComponent(projectId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mediaId: snapshot.mediaId,
            revision: snapshot.revision,
            segments,
            uiState: { playheadMs, zoom, muted },
          }),
        },
      );
      if (
        !mountedRef.current ||
        snapshot.id !== projectIdRef.current ||
        snapshot.request !== editorRequestsRef.current.save
      )
        return undefined;
      if (response.status === 409) {
        if (
          !mountedRef.current ||
          snapshot.editorVersion !== editorRequestsRef.current.editor ||
          snapshot.request !== editorRequestsRef.current.save
        )
          return undefined;
        setStatus(
          "Project changed on another client. Load latest before saving.",
        );
        return undefined;
      }
      if (!response.ok) {
        if (
          !mountedRef.current ||
          snapshot.editorVersion !== editorRequestsRef.current.editor ||
          snapshot.request !== editorRequestsRef.current.save
        )
          return undefined;
        throw new Error(`Project save failed (${response.status}).`);
      }
      const project = (await response.json()) as Project;
      if (
        !mountedRef.current ||
        snapshot.id !== projectIdRef.current ||
        snapshot.request !== editorRequestsRef.current.save
      )
        return undefined;
      if (snapshot.editorVersion !== editorRequestsRef.current.editor) {
        setRevision(project.revision);
        return undefined;
      }
      setRevision(project.revision);
      setDirty(false);
      rememberProject(project.id, selected.name);
      setStatus(`Project saved (revision ${project.revision}).`);
      return project;
    } catch (error) {
      if (
        mountedRef.current &&
        snapshot.id === projectIdRef.current &&
        snapshot.editorVersion === editorRequestsRef.current.editor &&
        snapshot.request === editorRequestsRef.current.save
      )
        setStatus(
          error instanceof Error ? error.message : "Project save failed.",
        );
      return undefined;
    }
  };

  const exportProject = async () => {
    const saved = await saveProject();
    if (!mountedRef.current || !saved) return;
    const request = ++exportRequestRef.current;
    if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
    setExportJob(undefined);
    setExportStatus("Starting export…");
    try {
      const response = await api.request(
        `projects/${encodeURIComponent(saved.id)}/exports`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: exportMode,
            selection: exportSelection,
            streamIndexes,
            cutStrategy,
            container: "mkv",
          }),
        },
      );
      if (!mountedRef.current || request !== exportRequestRef.current) return;
      if (response.status === 429) {
        setExportStatus("Export capacity is busy. Try again shortly.");
        return;
      }
      if (!response.ok) {
        setExportStatus("Export could not be started. Try again.");
        return;
      }
      const job = (await response.json()) as ExportJob;
      if (!mountedRef.current || request !== exportRequestRef.current) return;
      setExportJob(job);
      if (job.state !== "queued" && job.state !== "running") {
        setExportStatus(
          job.state === "succeeded"
            ? "Export complete."
            : job.state === "cancelled"
              ? "Export cancelled."
              : exportFailure(job.errorCode),
        );
        return;
      }
      setExportStatus(
        job.state === "queued" ? "Export queued." : "Export running.",
      );
      const poll = async () => {
        try {
          if (!mountedRef.current || request !== exportRequestRef.current)
            return;
          const nextResponse = await api.request(
            `jobs/${encodeURIComponent(job.id)}`,
          );
          if (!mountedRef.current || request !== exportRequestRef.current)
            return;
          if (!nextResponse.ok) {
            setExportStatus("Export status could not be updated. Try again.");
            return;
          }
          const next = (await nextResponse.json()) as ExportJob;
          if (!mountedRef.current || request !== exportRequestRef.current)
            return;
          setExportJob(next);
          if (next.state === "queued" || next.state === "running") {
            setExportStatus(
              next.state === "queued" ? "Export queued." : "Export running.",
            );
            exportTimerRef.current = window.setTimeout(() => void poll(), 1000);
            return;
          }
          setExportStatus(
            next.state === "succeeded"
              ? "Export complete."
              : next.state === "cancelled"
                ? "Export cancelled."
                : exportFailure(next.errorCode),
          );
        } catch {
          if (mountedRef.current && request === exportRequestRef.current)
            setExportStatus("Export status could not be updated. Try again.");
        }
      };
      exportTimerRef.current = window.setTimeout(() => void poll(), 1000);
    } catch {
      if (mountedRef.current && request === exportRequestRef.current)
        setExportStatus("Export could not be started. Try again.");
    }
  };

  const cancelDetection = async () => {
    const job = detectionJob;
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    detectionRequestRef.current += 1;
    if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current);
    setDetectionStatus("Cancelling detection…");
    try {
      const response = await api.request(`jobs/${encodeURIComponent(job.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Detection could not be cancelled.");
      setDetectionJob({ ...job, state: "cancelled" });
      setDetectionStatus("Detection cancelled.");
    } catch (error) { setDetectionStatus(error instanceof Error ? error.message : "Detection could not be cancelled."); }
  };

  const startDetection = async (kind: DetectionKind) => {
    if (!selected) return;
    const saved = await saveProject();
    if (!saved) return;
    const request = ++detectionRequestRef.current;
    if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current);
    setDetectionCandidates([]);
    setDetectionStatus(`Starting ${kind} detection…`);
    try {
      const response = await api.request(`projects/${encodeURIComponent(saved.id)}/detections`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mediaId: saved.mediaId, projectRevision: saved.revision, kind }),
      });
      if (request !== detectionRequestRef.current) return;
      if (!response.ok) { setDetectionStatus(response.status === 409 ? "Detection is stale; save or reload the project." : "Detection could not be started."); return; }
      const job = await response.json() as DetectionJob;
      setDetectionJob(job);
      const poll = async () => {
        if (request !== detectionRequestRef.current) return;
        try {
          const nextResponse = await api.request(`jobs/${encodeURIComponent(job.id)}`);
          if (request !== detectionRequestRef.current) return;
          if (!nextResponse.ok) throw new Error("Detection status could not be updated.");
          const next = await nextResponse.json() as DetectionJob;
          setDetectionJob(next);
          if (next.state === "queued" || next.state === "running") {
            setDetectionStatus(next.state === "queued" ? "Detection queued." : "Detection running.");
            detectionTimerRef.current = window.setTimeout(() => void poll(), 500);
          } else if (next.state === "succeeded") {
            setDetectionCandidates(next.candidates ?? []);
            setDetectionStatus(`${next.candidates?.length ?? 0} candidates found. Review each before accepting.`);
          } else if (next.state === "cancelled") setDetectionStatus("Detection cancelled.");
          else setDetectionStatus(`Detection failed${next.errorCode ? `: ${next.errorCode}.` : "."}`);
        } catch (error) { if (request === detectionRequestRef.current) setDetectionStatus(error instanceof Error ? error.message : "Detection status could not be updated."); }
      };
      if (job.state === "queued" || job.state === "running") detectionTimerRef.current = window.setTimeout(() => void poll(), 500);
      else if (job.state === "succeeded") setDetectionCandidates(job.candidates ?? []);
    } catch { if (request === detectionRequestRef.current) setDetectionStatus("Detection could not be started."); }
  };

  const acceptDetectionCandidate = (candidate: Candidate) => {
    if (!selected) return;
    const next = acceptCandidate(candidate, { id: projectId, mediaId: selected.id, revision, segments }, selected.durationMs);
    if (!next) { setDetectionStatus("Candidate is stale, invalid, or overlaps an existing segment."); return; }
    const error = validateSegments(next.segments, selected.durationMs);
    if (error) { setDetectionStatus(error); return; }
    invalidateEditor(); setSegments(next.segments); setDirty(true);
    setDetectionCandidates((current) => current.filter((item) => item.id !== candidate.id));
    setDetectionStatus("Candidate accepted; save the project to persist it.");
  };

  const rejectDetectionCandidate = (candidate: Candidate) => {
    setDetectionCandidates((current) => current.filter((item) => item.id !== candidate.id));
    setDetectionStatus("Candidate rejected.");
  };

  useEffect(() => () => { if (detectionTimerRef.current) window.clearTimeout(detectionTimerRef.current); }, []);

  const cancelExport = async () => {
    if (
      !exportJob ||
      (exportJob.state !== "queued" && exportJob.state !== "running")
    )
      return;
    const job = exportJob;
    const request = ++exportRequestRef.current;
    if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
    setExportStatus("Cancelling export…");
    try {
      const response = await api.request(`jobs/${encodeURIComponent(job.id)}`, {
        method: "DELETE",
      });
      if (!mountedRef.current || request !== exportRequestRef.current) return;
      if (!response.ok) {
        setExportStatus("Export could not be cancelled. Try again.");
        return;
      }
      setExportJob({ ...job, state: "cancelled" });
      setExportStatus("Export cancelled.");
    } catch {
      if (mountedRef.current && request === exportRequestRef.current)
        setExportStatus("Export could not be cancelled. Try again.");
    }
  };

  useEffect(() => {
    assetRequestRef.current?.abort();
    if (thumbnailURLRef.current) {
      URL.revokeObjectURL(thumbnailURLRef.current);
      thumbnailURLRef.current = undefined;
    }
    if (!selected) return;
    const controller = new AbortController(); assetRequestRef.current = controller;
    const params = { startMs: 0, durationMs: Math.max(1, Math.min(120000, selected.durationMs)), count: 16, width: 320 };
    void api.assetRequest(selected.id, "thumbnails", params, { signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error("Thumbnails unavailable");
      return response.blob();
    }).then((blob) => { if (!controller.signal.aborted) { const url = URL.createObjectURL(blob); thumbnailURLRef.current = url; setThumbnailURL(url); } }).catch(() => { if (!controller.signal.aborted) setAssetStatus("Thumbnails unavailable; editing remains available."); });
    void api.assetRequest(selected.id, "waveform", { startMs: 0, durationMs: Math.max(1, Math.min(120000, selected.durationMs)), samples: 256 }, { signal: controller.signal }).then(async (response) => {
      const value = await response.json() as { peaks?: unknown };
      if (!response.ok) throw new Error("Waveform unavailable");
      return normalizePeaks(value.peaks);
    }).then((peaks) => { if (!controller.signal.aborted) setWaveform(peaks); }).catch(() => { if (!controller.signal.aborted) setAssetStatus("Waveform unavailable (or media has no audio); editing remains available."); });
    return () => controller.abort();
  }, [selected]);

  const duration = mediaDuration(selected);
  const frameMs = frameDuration(selected);
  const previewSupported = canStreamPreview();
  return (
    <main aria-label="VideoCutlist segment selection">
      <header>
        <h1>VideoCutlist</h1>
        <p id="status" role="status" aria-live="polite">
          {status}
        </p>
      </header>
      <section aria-labelledby="media-heading">
        <h2 id="media-heading">Media</h2>
        <ul className="media-list" aria-label="Media list">
          {media.map((item) => (
            <li key={item.id}>
              <button
                aria-pressed={selected?.id === item.id}
                onClick={() => chooseMedia(item)}
              >
                {item.name}
                <span>
                  {formatTime(item.durationMs, item.durationMs)} ·{" "}
                  {item.container}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {nextCursor && (
          <button
            disabled={loadingMore}
            onClick={() => void loadMedia(nextCursor)}
          >
            {loadingMore ? "Loading more…" : "Load more"}
          </button>
        )}
        <button disabled={refreshingMedia} onClick={() => void refreshMedia()}>
          {refreshingMedia ? "Refreshing media…" : "Refresh media"}
        </button>
      </section>
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Timeline</h2>
        {selected ? (
          <>
            <p>
              <strong>{selected.name}</strong> ·{" "}
              {formatTime(selected.durationMs, duration)} ·{" "}
              {selected.sizeBytes.toLocaleString()} bytes
            </p>
            <label htmlFor="playhead">
              Playhead: {formatTime(playheadMs, duration)}
            </label>
            <p id="timeline-description">Playhead {formatTime(playheadMs, duration)}. In marker {formatTime(inMs, duration)}. Out marker {formatTime(outMs, duration)}. {segments.length ? `${segments.length} segment${segments.length === 1 ? "" : "s"} selected.` : "No segments selected."}</p>
            <div className="timeline-visual" role="group" aria-labelledby="timeline-heading timeline-description" style={{ width: `${viewportScale(zoom) * 100}%` }}>
              {thumbnailURL && <img src={thumbnailURL} alt="Timeline contact sheet" />}
              <div className="timeline-waveform" aria-hidden="true">
                {waveform.map((peak, index) => <i key={index} style={{ height: `${Math.max(2, peak * 100)}%` }} />)}
              </div>
              <span className="timeline-overlay timeline-in" style={{ left: `${(inMs / duration) * 100}%` }} aria-label="In marker" />
              <span className="timeline-overlay timeline-out" style={{ left: `${(outMs / duration) * 100}%` }} aria-label="Out marker" />
              {segments.map((segment) => <span key={`${segment.startMs}-${segment.endMs}`} className="timeline-segment" style={{ left: `${(segment.startMs / duration) * 100}%`, width: `${((segment.endMs - segment.startMs) / duration) * 100}%` }} aria-label={`Segment ${formatTime(segment.startMs, duration)} to ${formatTime(segment.endMs, duration)}`} />)}
              <span className="timeline-overlay timeline-playhead" style={{ left: `${(playheadMs / duration) * 100}%` }} aria-label="Playhead" />
            </div>
            {assetStatus && <p role="status">{assetStatus}</p>}
            <input
              id="playhead"
              aria-label="Timeline playhead"
              type="range"
              min="0"
              max={duration}
              step="1"
              value={playheadMs}
              onChange={(event) => {
                invalidateEditor();
                setPlayheadMs(Number(event.target.value));
                setDirty(true);
              }}
            />
            <div className="controls">
              <button
                disabled={!timelineHistory.past.length}
                onClick={undo}
                aria-label="Undo timeline edit"
              >
                Undo
              </button>
              <button
                disabled={!timelineHistory.future.length}
                onClick={redo}
                aria-label="Redo timeline edit"
              >
                Redo
              </button>
              <button
                onClick={() => {
                  invalidateEditor();
                  setInMs(markerPosition());
                  setDirty(true);
                }}
                aria-label="Set In marker"
              >
                Set In (I)
              </button>
              <button
                onClick={() => {
                  invalidateEditor();
                  setOutMs(markerPosition());
                  setDirty(true);
                }}
                aria-label="Set Out marker"
              >
                Set Out (O)
              </button>
              <button
                onClick={() => {
                  invalidateEditor();
                  setPlayheadMs((value) => Math.max(0, value - 1000));
                  setDirty(true);
                }}
                aria-label="Move playhead back one second"
              >
                −1s
              </button>
              <button
                onClick={() => {
                  invalidateEditor();
                  setPlayheadMs((value) => Math.min(duration, value + 1000));
                  setDirty(true);
                }}
                aria-label="Move playhead forward one second"
              >
                +1s
              </button>
            </div>
            <label htmlFor="timecode">Timecode</label>
            <input
              id="timecode"
              defaultValue={formatTime(playheadMs, duration)}
              onBlur={(event) => {
                const timecode = parseTimecode(event.target.value);
                if (timecode === undefined || timecode > duration) {
                  setStatus("Use M:SS.mmm inside the selected media.");
                  event.target.value = formatTime(playheadMs, duration);
                  return;
                }
                invalidateEditor();
                setDirty(true);
                setPlayheadMs(timecode);
              }}
            />
            {frameMs > 0 && (
              <button
                onClick={() => {
                  invalidateEditor();
                  setDirty(true);
                  setPlayheadMs((value) => Math.min(duration, value + frameMs));
                }}
              >
                Next frame
              </button>
            )}
            <p>
              In: {formatTime(inMs, duration)} · Out:{" "}
              {formatTime(outMs, duration)}
            </p>
            {previewSupported ? (
              <video
                ref={videoRef}
                controls
                muted={muted}
                aria-label="Preview player"
                data-preview-offset={diagnostics?.offsetMs ?? 0}
              />
            ) : (
              <p role="status">
                Preview is unavailable in this browser. Use the timeline
                controls to set markers manually.
              </p>
            )}
          </>
        ) : (
          <p>Select a media item.</p>
        )}
      </section>
      <section aria-labelledby="segments-heading">
        <h2 id="segments-heading">Segments</h2>
        <label htmlFor="segment-label">Label</label>
        <input
          id="segment-label"
          placeholder="Optional label"
          value={segmentLabel}
          onChange={(event) => setSegmentLabel(event.target.value)}
        />
        <button onClick={addSegment} disabled={!selected}>
          Add In/Out segment
        </button>
        <ol>
          {segments.map((segment, index) => (
            <li key={`${segment.startMs}-${segment.endMs}`}>
              {formatTime(segment.startMs, duration)} –{" "}
              {formatTime(segment.endMs, duration)}{" "}
              {segment.label ? `(${segment.label})` : ""}
              <button
                disabled={index === 0}
                onClick={() => {
                  invalidateEditor();
                  setSegments((value) => {
                    const next = [...value];
                    [next[index - 1], next[index]] = [
                      next[index],
                      next[index - 1],
                    ];
                    return next;
                  });
                  setDirty(true);
                }}
              >
                Move up
              </button>
              <button
                disabled={index === segments.length - 1}
                onClick={() => {
                  invalidateEditor();
                  setSegments((value) => {
                    const next = [...value];
                    [next[index], next[index + 1]] = [
                      next[index + 1],
                      next[index],
                    ];
                    return next;
                  });
                  setDirty(true);
                }}
              >
                Move down
              </button>
              <button
                onClick={() => {
                  invalidateEditor();
                  setSegments((value) =>
                    value.filter((_, itemIndex) => itemIndex !== index),
                  );
                  setDirty(true);
                }}
                aria-label={`Remove segment ${index + 1}`}
              >
                Remove
              </button>
            </li>
          ))}
        </ol>
      </section>
      <section aria-labelledby="detection-heading">
        <h2 id="detection-heading">Auto detection</h2>
        <p>{detectionStatus || "Review candidates before they change segments."}</p>
        <div className="controls">
          <button disabled={!selected || !!detectionJob && (detectionJob.state === "queued" || detectionJob.state === "running")} onClick={() => void startDetection("silence")}>Detect silence</button>
          <button disabled={!selected || !!detectionJob && (detectionJob.state === "queued" || detectionJob.state === "running")} onClick={() => void startDetection("black")}>Detect black frames</button>
          <button disabled={!selected || !!detectionJob && (detectionJob.state === "queued" || detectionJob.state === "running")} onClick={() => void startDetection("scene")}>Detect scene changes</button>
          {detectionJob && (detectionJob.state === "queued" || detectionJob.state === "running") && <button onClick={() => void cancelDetection()}>Cancel detection</button>}
        </div>
        {detectionCandidates.length > 0 && <ol aria-label="Detection candidates">
          {detectionCandidates.map((candidate) => <li key={candidate.id}>
            {candidate.source} · {formatTime(candidate.startMs, duration)}–{formatTime(candidate.endMs, duration)} · {Math.round(candidate.confidence * 100)}%
            <button onClick={() => acceptDetectionCandidate(candidate)}>Accept</button>
            <button onClick={() => rejectDetectionCandidate(candidate)}>Reject</button>
          </li>)}
        </ol>}
      </section>
      <section aria-labelledby="project-heading">
        <h2 id="project-heading">Project</h2>
        <label htmlFor="project-id">Project ID</label>
        <input
          id="project-id"
          value={projectId}
          onChange={(event) => {
            invalidateEditor();
            projectIdRef.current = event.target.value;
            setProjectId(event.target.value);
            setDirty(true);
          }}
        />
        <button onClick={newProject}>New project</button>
        <button onClick={() => void loadProject()}>Load project</button>
        <button onClick={() => void saveProject()}>Save project</button>
        <button disabled={!selected} onClick={() => void api.interchangeRequest(projectId, "csv").then(async (response) => { if (!response.ok) throw new Error("CSV export failed."); const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${projectId}.csv`; link.click(); URL.revokeObjectURL(link.href); }).catch(() => setStatus("CSV export failed."))}>Export CSV</button>
        <button disabled={!selected} onClick={() => void api.interchangeRequest(projectId, "chapters").then(async (response) => { if (!response.ok) throw new Error("Chapter export failed."); const blob = await response.blob(); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${projectId}.chapters.txt`; link.click(); URL.revokeObjectURL(link.href); }).catch(() => setStatus("Chapter export failed."))}>Export chapters</button>
        <label htmlFor="recent-projects">Recent projects</label>
        <select
          id="recent-projects"
          aria-label="Recent projects"
          defaultValue=""
          onChange={(event) => {
            if (event.target.value) void loadProject(event.target.value);
            event.target.value = "";
          }}
        >
          <option value="">Choose a recent project</option>
          {recent.map((project) => (
            <option key={project.id} value={project.id}>
              {project.label} ({project.id})
            </option>
          ))}
        </select>
        <button
          disabled={!selected}
          onClick={() => {
            const blob = new Blob(
              [
                projectJson({
                  version: 1,
                  mediaId: selected?.id,
                  revision,
                  segments,
                  uiState: { playheadMs, zoom, muted },
                }),
              ],
              { type: "application/json" },
            );
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a");
            link.href = url;
            link.download = `${projectId}.videocutlist.json`;
            link.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download cut list
        </button>
        <label htmlFor="project-file">Import cut list</label>
        <input
          id="project-file"
          type="file"
          accept="application/json,.json"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file
              .text()
              .then((text) => {
                const imported = parseProjectJson(text);
                if (!selected || imported.mediaId !== selected.id)
                  throw new Error(
                    "Select the cut list's media before importing.",
                  );
                const next = imported.segments as Segment[];
                const error = validateSegments(next, selected.durationMs);
                if (error) throw new Error(error);
                invalidateEditor();
                setSegments(next);
                setDirty(true);
                setStatus("Cut list imported. Save the project to keep it.");
              })
              .catch((error: unknown) =>
                setStatus(
                  error instanceof Error
                    ? error.message
                    : "Cut list import failed.",
                ),
              );
            event.target.value = "";
          }}
        />
        <label htmlFor="interchange-file">Import CSV or chapters</label>
        <input id="interchange-file" type="file" accept=".csv,.txt,text/csv,text/plain" onChange={(event) => { const file = event.target.files?.[0]; if (!file) return; if (!validInterchangeFileSize(file.size)) { setStatus("Interchange file exceeds the 1 MiB limit."); event.target.value = ""; return; } const format = file.name.toLowerCase().endsWith(".csv") ? "csv" : "chapters"; void file.arrayBuffer().then((body) => api.interchangeRequest(projectId, format, { method: "POST", body, headers: { "Content-Type": format === "csv" ? "text/csv" : "text/plain" } })).then(async (response) => { if (!response.ok) throw new Error("Interchange import failed."); const value = await response.json() as { segments: Segment[]; revision: number }; invalidateEditor(); setSegments(value.segments); setRevision(value.revision); setDirty(false); setStatus("Interchange imported."); }).catch(() => setStatus("Interchange import failed.")); event.target.value = ""; }} />
        <label htmlFor="export-mode">Output</label>
        <select
          id="export-mode"
          value={exportMode}
          onChange={(event) =>
            setExportMode(event.target.value as "merge" | "separate")
          }
        >
          <option value="merge">Merge cuts</option>
          <option value="separate">Separate files</option>
        </select>
        <label htmlFor="export-selection">Selection</label>
        <select
          id="export-selection"
          value={exportSelection}
          onChange={(event) =>
            setExportSelection(event.target.value as "segments" | "gaps")
          }
        >
          <option value="segments">Selected segments</option>
          <option value="gaps">Unselected gaps</option>
        </select>
        <label htmlFor="cut-strategy">Cut accuracy</label>
        <select
          id="cut-strategy"
          value={cutStrategy}
          onChange={(event) =>
            setCutStrategy(
              event.target.value as
                | "stream_copy_preferred"
                | "precise_reencode"
                | "hybrid_smart_cut",
            )
          }
        >
          <option value="stream_copy_preferred">
            Fast stream copy, keyframe dependent
          </option>
          <option value="precise_reencode">
            Experimental precise re-encode
          </option>
          <option value="hybrid_smart_cut" disabled={hybridSmartCutUnavailable}>
            Experimental hybrid Smart Cut (H.264 CFR MKV)
          </option>
        </select>
        <p>
          Stream-copy starts may move to an earlier keyframe. They are not
          frame-exact.
        </p>
        {hybridSmartCutUnavailable && (
          <p>
            Hybrid Smart Cut is unavailable for this file. It supports H.264
            constant-frame-rate video in MKV only. Use Stream Copy or Precise
            Re-encode instead.
          </p>
        )}
        {tracks(selected).map((track) => (
          <label key={track.index}>
            <input
              type="checkbox"
              checked={
                streamIndexes.length === 0 ||
                streamIndexes.includes(track.index)
              }
              onChange={(event) =>
                setStreamIndexes((current) => {
                  const selectedTracks = current.length
                    ? current
                    : tracks(selected).map((item) => item.index);
                  return event.target.checked
                    ? [...selectedTracks, track.index].filter(
                        (value, index, values) =>
                          values.indexOf(value) === index,
                      )
                    : selectedTracks.filter((value) => value !== track.index);
                })
              }
            />{" "}
            {track.index}: {track.type} ({track.codec})
          </label>
        ))}
        <button
          onClick={() => void exportProject()}
          disabled={!selected || !segments.length}
        >
          Export MKV
        </button>
        {exportStatus && <p role="status">{exportStatus}</p>}
        {exportJob &&
          (exportJob.state === "queued" || exportJob.state === "running") && (
            <button onClick={() => void cancelExport()}>Cancel export</button>
          )}
        {exportJob?.state === "succeeded" && exportJob.result && (
          <div aria-label="Export result">
            <p>
              Export:{" "}
              {exportJob.result.outputName ??
                exportJob.result.outputNames?.join(", ")}
            </p>
            <p>Size: {exportJob.result.sizeBytes.toLocaleString()} bytes</p>
            <p>
              Retained until:{" "}
              {new Date(exportJob.result.retainUntil).toLocaleString()}
            </p>
            {exportJob.warnings?.length ? (
              <ul aria-label="Export warnings">
                {exportJob.warnings.map((warning, index) => (
                  <li key={`${index}-${warning}`}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
        <label>
          <input
            type="checkbox"
            checked={muted}
            onChange={(event) => {
              invalidateEditor();
              setMuted(event.target.checked);
              setDirty(true);
            }}
          />{" "}
          Mute preview
        </label>
      </section>
      <section aria-labelledby="diagnostics-heading">
        <h2 id="diagnostics-heading">Preview diagnostics</h2>
        <dl>
          <dt>MSE</dt>
          <dd>{canStreamPreview() ? "supported" : "unsupported"}</dd>
          <dt>Cache</dt>
          <dd>{diagnostics?.cache ?? "—"}</dd>
          <dt>Request ID</dt>
          <dd>{diagnostics?.requestId ?? "—"}</dd>
          <dt>Offset</dt>
          <dd>{diagnostics ? `${diagnostics.offsetMs} ms` : "—"}</dd>
          <dt>Window</dt>
          <dd>
            {diagnostics
              ? `${diagnostics.startMs} ms / ${diagnostics.durationMs} ms`
              : "—"}
          </dd>
          <dt>Response</dt>
          <dd>{diagnostics ? `${diagnostics.elapsedMs} ms` : "—"}</dd>
        </dl>
      </section>
    </main>
  );
}
