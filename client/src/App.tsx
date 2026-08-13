import { useCallback, useEffect, useRef, useState } from "react";
import { createApiClient, resolveBrowserConfiguration } from "./api";
import {
  canStreamPreview,
  formatTime,
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
  recentProjects,
  recentProjectsKey,
  type RecentProject,
  validProjectId,
} from "./projectLifecycle";
type Project = {
  id: string;
  mediaId: string;
  revision: number;
  segments: Segment[];
  uiState: { playheadMs: number; zoom: number; muted: boolean };
};

type ExportJob = {
  id: string;
  type: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress: number;
  result?: { outputName: string; sizeBytes: number; retainUntil: string };
  warnings?: string[];
  errorCode?: string;
};

type MediaPage = { items: Media[]; nextCursor?: string | null };

const api = createApiClient(resolveBrowserConfiguration());

const mediaDuration = (media?: Media) => media?.durationMs ?? 0;

const exportFailures: Record<string, string> = {
    interrupted_by_restart: "Export was interrupted by a server restart. Try again.",
    invalid_export_request: "Export request was invalid. Try again.",
    media_unavailable: "Selected media is unavailable. Choose media and try again.",
    export_failed: "Export failed. Try again.",
    result_encoding_failed: "Export failed while preparing its result. Try again.",
  };

const exportFailure = (code?: string) =>
  exportFailures[code ?? ""] ?? "Export failed. Try again.";

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const selectionRef = useRef(0);
  const exportRequestRef = useRef(0);
  const exportTimerRef = useRef<number | undefined>(undefined);
  const loadRequestRef = useRef<AbortController | undefined>(undefined);
  const loadRequestVersionRef = useRef(0);
  const editorVersionRef = useRef(0);
  const saveRequestVersionRef = useRef(0);
  const mediaRequestRef = useRef<AbortController | undefined>(undefined);
  const mediaRequestVersionRef = useRef(0);
  const refreshRequestRef = useRef<AbortController | undefined>(undefined);
  const refreshRequestVersionRef = useRef(0);
  const metadataRequestRef = useRef<AbortController | undefined>(undefined);
  const metadataRequestVersionRef = useRef(0);
  const selectedRef = useRef<Media | undefined>(undefined);
  const [media, setMedia] = useState<Media[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshingMedia, setRefreshingMedia] = useState(false);
  const [selected, setSelected] = useState<Media>();
  const [playheadMs, setPlayheadMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [inMs, setInMs] = useState(0);
  const [outMs, setOutMs] = useState(0);
  const [segmentLabel, setSegmentLabel] = useState("");
  const [projectId, setProjectId] = useState(newProjectId);
  const projectIdRef = useRef(projectId);
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("Loading media…");
  const [diagnostics, setDiagnostics] = useState<PreviewDiagnostics>();
  const [zoom, setZoom] = useState(1);
  const [muted, setMuted] = useState(false);
  const [exportJob, setExportJob] = useState<ExportJob>();
  const [exportStatus, setExportStatus] = useState("");
  const [dirty, setDirty] = useState(false);
  const [recent, setRecent] = useState<RecentProject[]>(() => {
    try {
      return recentProjects(JSON.parse(localStorage.getItem(recentProjectsKey) ?? "[]"));
    } catch {
      return [];
    }
  });
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      cleanupRef.current?.();
      loadRequestRef.current?.abort();
      mediaRequestRef.current?.abort();
      refreshRequestRef.current?.abort();
      metadataRequestRef.current?.abort();
      if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
      selectionRef.current += 1;
      exportRequestRef.current += 1;
      loadRequestVersionRef.current += 1;
      editorVersionRef.current += 1;
      saveRequestVersionRef.current += 1;
      mediaRequestVersionRef.current += 1;
      refreshRequestVersionRef.current += 1;
      metadataRequestVersionRef.current += 1;
    };
  }, []);

  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  useEffect(() => {
    projectIdRef.current = projectId;
  }, [projectId]);

  const invalidateEditor = useCallback(() => {
    editorVersionRef.current += 1;
    loadRequestRef.current?.abort();
    metadataRequestRef.current?.abort();
    metadataRequestVersionRef.current += 1;
  }, []);

  const rememberProject = useCallback((id: string, label: string) => {
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
  }, [recent]);

  const clearExport = useCallback(() => {
    exportRequestRef.current += 1;
    if (exportTimerRef.current) window.clearTimeout(exportTimerRef.current);
    setExportJob(undefined);
    setExportStatus("");
  }, []);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const chooseMedia = useCallback((item: Media) => {
    if (!confirmDiscard(dirty, () => window.confirm("Discard unsaved changes?")))
      return;
    clearExport();
    invalidateEditor();
    selectedRef.current = item;
    setSelected(item);
    setPlayheadMs(0);
    setInMs(0);
    setOutMs(0);
    setSegments([]);
    setDiagnostics(undefined);
    setDirty(true);
    setStatus(`Selected ${item.name}.`);
    const controller = new AbortController();
    metadataRequestRef.current = controller;
    const request = ++metadataRequestVersionRef.current;
    void api
      .request(`media/${encodeURIComponent(item.id)}`, { signal: controller.signal })
      .then((response) =>
        response.ok
          ? (response.json() as Promise<Media>)
          : Promise.reject(
              new Error(`Metadata request failed (${response.status}).`),
            ),
      )
      .then((metadata) => {
        if (mountedRef.current && !controller.signal.aborted && request === metadataRequestVersionRef.current && selectedRef.current?.id === metadata.id) {
          selectedRef.current = metadata;
          setSelected(metadata);
        }
      })
      .catch((error: unknown) => {
        if (mountedRef.current && !controller.signal.aborted && request === metadataRequestVersionRef.current && selectedRef.current?.id === item.id)
          setStatus(error instanceof Error ? error.message : "Metadata request failed.");
      });
  }, [clearExport, dirty, invalidateEditor]);

  const loadMedia = useCallback(async (cursor?: string, refreshed = false) => {
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
      )
      const page = (await response) as MediaPage;
      if (!mountedRef.current || request !== mediaRequestVersionRef.current) return;
      setNextCursor(page.nextCursor || null);
      if (cursor) {
        setMedia((current) => [
          ...current,
          ...page.items.filter((item) => !current.some((known) => known.id === item.id)),
        ]);
      } else {
        setMedia(page.items);
        setStatus(
          page.items.length
            ? refreshed ? "Media refreshed. Choose media to begin." : "Choose media to begin."
            : "No media found.",
        );
        const selectedItem = selectedRef.current;
        if (refreshed && selectedItem) {
          const item = page.items.find((candidate) => candidate.id === selectedItem.id);
          if (item) setSelected(item);
          else {
            const metadata = await api.request(`media/${encodeURIComponent(selectedItem.id)}`, { signal: controller.signal });
            if (!mountedRef.current || request !== mediaRequestVersionRef.current || controller.signal.aborted) return;
            if (metadata.ok) {
              const item = await metadata.json() as Media;
              if (mountedRef.current && selectedRef.current?.id === selectedItem.id && request === mediaRequestVersionRef.current)
                setSelected(item);
            }
            else if (metadata.status === 404)
              if (mountedRef.current && selectedRef.current?.id === selectedItem.id)
                setStatus("Selected media is no longer indexed. Unsaved project changes were kept.");
          }
        }
      }
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted && request === mediaRequestVersionRef.current && !cursor)
        setStatus(error instanceof Error ? error.message : "Unable to load media.");
    } finally {
      if (mountedRef.current && request === mediaRequestVersionRef.current && cursor) setLoadingMore(false);
    }
  }, []);

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
    metadataRequestVersionRef.current += 1;
    refreshRequestRef.current?.abort();
    const controller = new AbortController();
    refreshRequestRef.current = controller;
    const request = ++refreshRequestVersionRef.current;
    setRefreshingMedia(true);
    try {
      const response = await api.request("media/refresh", { method: "POST", signal: controller.signal });
      if (!mountedRef.current || controller.signal.aborted || request !== refreshRequestVersionRef.current) return;
      if (response.status === 403) setStatus("You are not allowed to refresh media.");
      else if (response.status === 429) setStatus("Media refresh is already in progress. Try again shortly.");
      else if (!response.ok) setStatus("Media refresh failed. Try again.");
      else await loadMedia(undefined, true);
    } catch {
      if (mountedRef.current && !controller.signal.aborted && request === refreshRequestVersionRef.current)
        setStatus("Media refresh failed. Try again.");
    } finally {
      if (mountedRef.current && request === refreshRequestVersionRef.current) setRefreshingMedia(false);
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
            if (!mountedRef.current || request !== selectionRef.current || controller.signal.aborted)
              return;
            setDiagnostics(next);
            setStatus("Preview ready.");
          },
          (error) => {
            if (!mountedRef.current || request !== selectionRef.current || controller.signal.aborted)
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
  }, [muted, playheadMs, selected]);


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
      if (
        (event.target instanceof HTMLInputElement &&
          event.target.type !== "range") ||
        event.target instanceof HTMLTextAreaElement ||
        !selected
      )
        return;
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
  }, [invalidateEditor, markerPosition, playheadMs, selected]);

  const addSegment = () => {
    const next = [
      ...segments,
      { startMs: inMs, endMs: outMs, label: segmentLabel || undefined },
    ];
    const error = validateSegments(next, mediaDuration(selected));
    if (error) return setStatus(error);
    invalidateEditor();
    setSegments(next.sort((a, b) => a.startMs - b.startMs));
    setSegmentLabel("");
    setDirty(true);
    setStatus("Segment added.");
  };

  const loadProject = async (id = projectId) => {
    if (!validProjectId(id)) {
      setStatus("Project ID is invalid.");
      return;
    }
    if (!confirmDiscard(dirty, () => window.confirm("Discard unsaved changes?")))
      return;
    invalidateEditor();
    loadRequestRef.current?.abort();
    const controller = new AbortController();
    loadRequestRef.current = controller;
    const request = ++loadRequestVersionRef.current;
    const editorVersion = editorVersionRef.current;
    try {
      const response = await api.request(
        `projects/${encodeURIComponent(id)}`,
        { signal: controller.signal },
      );
      if (!response.ok)
        throw new Error(`Project load failed (${response.status}).`);
      const project = (await response.json()) as Project;
      if (!mountedRef.current || controller.signal.aborted || request !== loadRequestVersionRef.current || editorVersion !== editorVersionRef.current)
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
      if (!mountedRef.current || controller.signal.aborted || request !== loadRequestVersionRef.current || editorVersion !== editorVersionRef.current)
        return;
      clearExport();
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
      rememberProject(project.id, item.name);
      setStatus("Project loaded.");
    } catch (error) {
      if (mountedRef.current && !controller.signal.aborted && request === loadRequestVersionRef.current && editorVersion === editorVersionRef.current)
        setStatus(error instanceof Error ? error.message : "Project load failed.");
    }
  };

  const newProject = () => {
    if (!confirmDiscard(dirty, () => window.confirm("Discard unsaved changes?")))
      return;
    invalidateEditor();
    clearExport();
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
      editorVersion: editorVersionRef.current,
      request: ++saveRequestVersionRef.current,
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
      if (!mountedRef.current || snapshot.id !== projectIdRef.current || snapshot.request !== saveRequestVersionRef.current)
        return undefined;
      if (response.status === 409) {
        if (!mountedRef.current || snapshot.editorVersion !== editorVersionRef.current || snapshot.request !== saveRequestVersionRef.current)
          return undefined;
        setStatus(
          "Project changed on another client. Load latest before saving.",
        );
        return undefined;
      }
      if (!response.ok) {
        if (!mountedRef.current || snapshot.editorVersion !== editorVersionRef.current || snapshot.request !== saveRequestVersionRef.current)
          return undefined;
        throw new Error(`Project save failed (${response.status}).`);
      }
      const project = (await response.json()) as Project;
      if (!mountedRef.current || snapshot.id !== projectIdRef.current || snapshot.request !== saveRequestVersionRef.current)
        return undefined;
      if (snapshot.editorVersion !== editorVersionRef.current) {
        setRevision(project.revision);
        return undefined;
      }
      setRevision(project.revision);
      setDirty(false);
      rememberProject(project.id, selected.name);
      setStatus(`Project saved (revision ${project.revision}).`);
      return project;
    } catch (error) {
      if (mountedRef.current && snapshot.id === projectIdRef.current && snapshot.editorVersion === editorVersionRef.current && snapshot.request === saveRequestVersionRef.current)
        setStatus(error instanceof Error ? error.message : "Project save failed.");
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
            mode: "merge",
            cutStrategy: "stream_copy_preferred",
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
          if (!mountedRef.current || request !== exportRequestRef.current) return;
          const nextResponse = await api.request(
            `jobs/${encodeURIComponent(job.id)}`,
          );
          if (!mountedRef.current || request !== exportRequestRef.current) return;
          if (!nextResponse.ok) {
            setExportStatus("Export status could not be updated. Try again.");
            return;
          }
          const next = (await nextResponse.json()) as ExportJob;
          if (!mountedRef.current || request !== exportRequestRef.current) return;
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

  const cancelExport = async () => {
    if (!exportJob || (exportJob.state !== "queued" && exportJob.state !== "running"))
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

  const duration = mediaDuration(selected);
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
                  {formatTime(item.durationMs, item.durationMs)} · {item.container}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {nextCursor && (
          <button disabled={loadingMore} onClick={() => void loadMedia(nextCursor)}>
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
            <label htmlFor="playhead">Playhead: {formatTime(playheadMs, duration)}</label>
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
            <p>
              In: {formatTime(inMs, duration)} · Out: {formatTime(outMs, duration)}
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
              <p role="status">Preview is unavailable in this browser. Use the timeline controls to set markers manually.</p>
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
              {formatTime(segment.startMs, duration)} – {formatTime(segment.endMs, duration)}{" "}
              {segment.label ? `(${segment.label})` : ""}
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
          onClick={() => void exportProject()}
          disabled={!selected || !segments.length}
        >
          Export MKV
        </button>
        {exportStatus && <p role="status">{exportStatus}</p>}
        {exportJob && (exportJob.state === "queued" || exportJob.state === "running") && (
          <button onClick={() => void cancelExport()}>Cancel export</button>
        )}
        {exportJob?.state === "succeeded" && exportJob.result && (
          <div aria-label="Export result">
            <p>Export: {exportJob.result.outputName}</p>
            <p>Size: {exportJob.result.sizeBytes.toLocaleString()} bytes</p>
            <p>Retained until: {new Date(exportJob.result.retainUntil).toLocaleString()}</p>
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
