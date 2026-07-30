import { useCallback, useEffect, useRef, useState } from "react";
import {
  canStreamPreview,
  streamPreview,
  validateSegments,
  type Media,
  type PreviewDiagnostics,
  type Segment,
} from "./preview";
type Project = {
  id: string;
  mediaId: string;
  revision: number;
  segments: Segment[];
  uiState: { playheadMs: number; zoom: number; muted: boolean };
};

const api = "/api/v1";

const formatTime = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

const mediaDuration = (media?: Media) => media?.durationMs ?? 0;

export function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const abortRef = useRef<AbortController | undefined>(undefined);
  const cleanupRef = useRef<(() => void) | undefined>(undefined);
  const selectionRef = useRef(0);
  const [media, setMedia] = useState<Media[]>([]);
  const [selected, setSelected] = useState<Media>();
  const [playheadMs, setPlayheadMs] = useState(0);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [inMs, setInMs] = useState(0);
  const [outMs, setOutMs] = useState(0);
  const [segmentLabel, setSegmentLabel] = useState("");
  const [projectId, setProjectId] = useState("p_demo-project");
  const [revision, setRevision] = useState(0);
  const [status, setStatus] = useState("Loading media…");
  const [diagnostics, setDiagnostics] = useState<PreviewDiagnostics>();
  const [zoom, setZoom] = useState(1);
  const [muted, setMuted] = useState(false);

  const chooseMedia = useCallback((item: Media) => {
    setSelected(item);
    setPlayheadMs(0);
    setInMs(0);
    setOutMs(0);
    setSegments([]);
    setStatus(`Selected ${item.name}.`);
    void fetch(`${api}/media/${encodeURIComponent(item.id)}`)
      .then((response) =>
        response.ok
          ? (response.json() as Promise<Media>)
          : Promise.reject(
              new Error(`Metadata request failed (${response.status}).`),
            ),
      )
      .then((metadata) =>
        setSelected((current) =>
          current?.id === metadata.id ? metadata : current,
        ),
      )
      .catch((error: unknown) =>
        setStatus(
          error instanceof Error ? error.message : "Metadata request failed.",
        ),
      );
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`${api}/media?limit=50`, { signal: controller.signal })
      .then((response) =>
        response.ok
          ? response.json()
          : Promise.reject(
              new Error(`Media request failed (${response.status}).`),
            ),
      )
      .then((page: { items: Media[] }) => {
        setMedia(page.items);
        setStatus(
          page.items.length ? "Choose media to begin." : "No media found.",
        );
      })
      .catch(
        (error: unknown) =>
          !controller.signal.aborted &&
          setStatus(
            error instanceof Error ? error.message : "Unable to load media.",
          ),
      );
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!selected || !canStreamPreview()) {
      return;
    }
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
          `${api}/media/${encodeURIComponent(selected.id)}/preview?${params}`,
          controller.signal,
          (next) => {
            if (request !== selectionRef.current || controller.signal.aborted)
              return;
            setDiagnostics(next);
            setStatus("Preview ready.");
          },
        );
      } catch (error) {
        if (!controller.signal.aborted)
          setStatus(error instanceof Error ? error.message : "Preview failed.");
      }
    }, 200);
    return () => {
      window.clearTimeout(timer);
      abortRef.current?.abort();
      cleanupRef.current?.();
    };
  }, [muted, playheadMs, selected]);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      cleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement ||
        !selected
      )
        return;
      if (event.key === "i" || event.key === "I") {
        event.preventDefault();
        setInMs(playheadMs);
      }
      if (event.key === "o" || event.key === "O") {
        event.preventDefault();
        setOutMs(playheadMs);
      }
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        setPlayheadMs((value) =>
          Math.max(
            0,
            Math.min(
              selected.durationMs,
              value + (event.key === "ArrowLeft" ? -1000 : 1000),
            ),
          ),
        );
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
  }, [playheadMs, selected]);

  const addSegment = () => {
    const next = [
      ...segments,
      { startMs: inMs, endMs: outMs, label: segmentLabel || undefined },
    ];
    const error = validateSegments(next, mediaDuration(selected));
    if (error) return setStatus(error);
    setSegments(next.sort((a, b) => a.startMs - b.startMs));
    setSegmentLabel("");
    setStatus("Segment added.");
  };

  const loadProject = async () => {
    try {
      const response = await fetch(
        `${api}/projects/${encodeURIComponent(projectId)}`,
      );
      if (!response.ok)
        throw new Error(`Project load failed (${response.status}).`);
      const project = (await response.json()) as Project;
      setRevision(project.revision);
      setSegments(project.segments);
      setPlayheadMs(project.uiState.playheadMs);
      setZoom(project.uiState.zoom);
      setMuted(project.uiState.muted);
      const item = media.find((candidate) => candidate.id === project.mediaId);
      if (item) setSelected(item);
      setStatus("Project loaded.");
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Project load failed.",
      );
    }
  };

  const saveProject = async () => {
    if (!selected) return setStatus("Select media before saving.");
    const error = validateSegments(segments, selected.durationMs);
    if (error) return setStatus(error);
    try {
      const response = await fetch(
        `${api}/projects/${encodeURIComponent(projectId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mediaId: selected.id,
            revision,
            segments,
            uiState: { playheadMs, zoom, muted },
          }),
        },
      );
      if (response.status === 409)
        return setStatus(
          "Project changed on another client. Load latest before saving.",
        );
      if (!response.ok)
        throw new Error(`Project save failed (${response.status}).`);
      const project = (await response.json()) as Project;
      setRevision(project.revision);
      setStatus(`Project saved (revision ${project.revision}).`);
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Project save failed.",
      );
    }
  };

  const duration = mediaDuration(selected);
  return (
    <main aria-label="EditApp segment selection">
      <header>
        <h1>EditApp</h1>
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
                  {formatTime(item.durationMs)} · {item.container}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="timeline-heading">
        <h2 id="timeline-heading">Timeline</h2>
        {selected ? (
          <>
            <p>
              <strong>{selected.name}</strong> ·{" "}
              {formatTime(selected.durationMs)} ·{" "}
              {selected.sizeBytes.toLocaleString()} bytes
            </p>
            <label htmlFor="playhead">Playhead: {formatTime(playheadMs)}</label>
            <input
              id="playhead"
              aria-label="Timeline playhead"
              type="range"
              min="0"
              max={duration}
              step="1"
              value={playheadMs}
              onChange={(event) => setPlayheadMs(Number(event.target.value))}
            />
            <div className="controls">
              <button
                onClick={() => setInMs(playheadMs)}
                aria-label="Set In marker"
              >
                Set In (I)
              </button>
              <button
                onClick={() => setOutMs(playheadMs)}
                aria-label="Set Out marker"
              >
                Set Out (O)
              </button>
              <button
                onClick={() =>
                  setPlayheadMs((value) => Math.max(0, value - 1000))
                }
                aria-label="Move playhead back one second"
              >
                −1s
              </button>
              <button
                onClick={() =>
                  setPlayheadMs((value) => Math.min(duration, value + 1000))
                }
                aria-label="Move playhead forward one second"
              >
                +1s
              </button>
            </div>
            <p>
              In: {formatTime(inMs)} · Out: {formatTime(outMs)}
            </p>
            <video
              ref={videoRef}
              controls
              muted={muted}
              aria-label="Preview player"
              data-preview-offset={diagnostics?.offsetMs ?? 0}
            />
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
              {formatTime(segment.startMs)} – {formatTime(segment.endMs)}{" "}
              {segment.label ? `(${segment.label})` : ""}
              <button
                onClick={() =>
                  setSegments((value) =>
                    value.filter((_, itemIndex) => itemIndex !== index),
                  )
                }
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
          onChange={(event) => setProjectId(event.target.value)}
        />
        <button onClick={() => void loadProject()}>Load project</button>
        <button onClick={() => void saveProject()}>Save project</button>
        <label htmlFor="zoom">Timeline zoom</label>
        <input
          id="zoom"
          type="number"
          min="0.1"
          step="0.1"
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
        <label>
          <input
            type="checkbox"
            checked={muted}
            onChange={(event) => setMuted(event.target.checked)}
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
