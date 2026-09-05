import { createEffect, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import type { components } from "../../generated/api";
import { frameDuration } from "./frame";
import {
  moveSegment as moveSegments,
  moveSegmentTo,
  removeSegment as removeSegments,
  resizeSegment,
  splitSegment,
} from "./segmentEditing";
import {
  createTimelineHistory,
  editTimeline,
  redoTimeline,
  undoTimeline,
  updateTimelinePlayback,
  type TimelineHistory,
} from "./timeline";
import { validateSegments, type Segment } from "../preview/model";

type Media = components["schemas"]["Media"];
type Track = {
  index: number;
  type: string;
  codec: string;
  language?: string;
  disposition?: string[];
};

export function createEditorController(deps: {
  selected: Accessor<Media | undefined>;
  setStatus: Setter<string>;
  markDirty: () => void;
  setPreviewCenterMs: (ms: number) => void;
  watchedPosition: Accessor<number>;
  togglePlayback: () => void;
}) {
  const [segmentLabel, setSegmentLabel] = createSignal("");
  const [timecode, setTimecode] = createSignal("");
  const [activeSegmentIndex, setActiveSegmentIndex] = createSignal<number>();
  const [timeline, setTimeline] = createSignal<TimelineHistory>(
    createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 }),
  );
  const present = () => timeline().present;
  const playheadMs = () => present().playheadMs;
  const duration = () => deps.selected()?.durationMs ?? 0;
  const tracks = (): Track[] => {
    const value = deps.selected()?.streams.tracks;
    return Array.isArray(value)
      ? value.filter(
          (track): track is Track =>
            !!track &&
            typeof track === "object" &&
            Number.isInteger((track as { index?: unknown }).index) &&
            typeof (track as { type?: unknown }).type === "string" &&
            typeof (track as { codec?: unknown }).codec === "string" &&
            ["video", "audio", "subtitle"].includes((track as { type: string }).type),
        )
      : [];
  };
  const updateTimeline = (changes: Partial<TimelineHistory["present"]>) => {
    const next = editTimeline(timeline(), changes);
    setTimeline(next);
    if (changes.playheadMs !== undefined) deps.setPreviewCenterMs(next.present.playheadMs);
    deps.markDirty();
  };
  const updatePlaybackPosition = (positionMs: number) => {
    const nextPosition = Math.max(0, Math.min(duration(), Math.round(positionMs)));
    if (nextPosition !== present().playheadMs)
      setTimeline(updateTimelinePlayback(timeline(), nextPosition));
  };
  const setMarker = (kind: "inMs" | "outMs", value: number) => {
    setTimeline(editTimeline(timeline(), { [kind]: value }));
    deps.markDirty();
  };
  const addSegment = () => {
    const item = deps.selected();
    const { inMs, outMs } = present();
    if (!item || inMs === undefined || outMs === undefined || inMs >= outMs)
      return deps.setStatus("Set an in point before the out point.");
    const segment: Segment = {
      startMs: inMs,
      endMs: outMs,
      label: segmentLabel().trim() || undefined,
    };
    const next = [...present().segments, segment];
    const error = validateSegments(next, item.durationMs);
    if (error) return deps.setStatus(error);
    updateTimeline({ segments: next });
    setActiveSegmentIndex(next.length - 1);
  };
  const removeSegment = (index: number) => {
    const next = removeSegments(present().segments, index);
    updateTimeline({ segments: next });
    const active = activeSegmentIndex();
    if (active === index) setActiveSegmentIndex();
    else if (active !== undefined && active > index) setActiveSegmentIndex(active - 1);
  };
  const moveSegment = (index: number, direction: -1 | 1) => {
    const current = present().segments;
    const next = moveSegments(current, index, direction);
    updateTimeline({ segments: next });
    if (next !== current) {
      const active = activeSegmentIndex();
      const target = index + direction;
      if (active === index) setActiveSegmentIndex(target);
      else if (active === target) setActiveSegmentIndex(index);
    }
  };
  const updateSegment = (
    index: number,
    change: { boundary: "start" | "end"; valueMs: number } | { startMs: number },
  ) =>
    updateTimeline({
      segments:
        "boundary" in change
          ? resizeSegment(present().segments, index, change.boundary, change.valueMs, duration())
          : moveSegmentTo(present().segments, index, change.startMs, duration()),
    });
  const updateSegmentLabel = (index: number, label: string) =>
    updateTimeline({
      segments: present().segments.map((segment, position) =>
        position === index ? { ...segment, label: label.trim() || undefined } : segment,
      ),
    });
  const splitActiveSegment = () => {
    const index = activeSegmentIndex();
    if (index === undefined) return;
    const next = splitSegment(present().segments, index, playheadMs());
    if (next === present().segments)
      return deps.setStatus("Place the playhead inside the active cut to split it.");
    updateTimeline({ segments: next });
    setActiveSegmentIndex(index + 1);
  };

  createEffect(() => {
    deps.selected();
    setActiveSegmentIndex();
  });

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (target.matches("input, textarea, select, [contenteditable='true']")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const step = frameDuration(deps.selected()) || 1000;
        updateTimeline({
          playheadMs: Math.max(
            0,
            Math.min(duration(), playheadMs() + (event.key === "ArrowLeft" ? -step : step)),
          ),
        });
      } else if (event.key === " ") {
        event.preventDefault();
        deps.togglePlayback();
      } else if (event.key.toLowerCase() === "i" || event.key.toLowerCase() === "o") {
        event.preventDefault();
        setMarker(event.key.toLowerCase() === "i" ? "inMs" : "outMs", deps.watchedPosition());
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        splitActiveSegment();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        const index = activeSegmentIndex();
        if (index !== undefined) {
          event.preventDefault();
          removeSegment(index);
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        const next = event.shiftKey ? redoTimeline(timeline()) : undoTimeline(timeline());
        setTimeline(next);
        deps.setPreviewCenterMs(next.present.playheadMs);
        deps.markDirty();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        const next = redoTimeline(timeline());
        setTimeline(next);
        deps.setPreviewCenterMs(next.present.playheadMs);
        deps.markDirty();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  return {
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    timeline,
    setTimeline,
    activeSegmentIndex,
    setActiveSegmentIndex,
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
    updateSegment,
    updateSegmentLabel,
    splitActiveSegment,
  };
}
