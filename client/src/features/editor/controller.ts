import { createEffect, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import type { components } from "../../generated/api";
import { frameDuration } from "./frame";
import {
  moveSegment as moveSegments,
  moveSegmentTo,
  removeSegment as removeSegments,
  resizeSegmentInteractive,
  splitSegment,
} from "./segmentEditing";
import {
  createTimelineHistory,
  editTimeline,
  redoTimeline,
  undoTimeline,
  updateTimelineDraft,
  updateTimelinePlayback,
  updateTimelineView,
  type TimelineHistory,
} from "./timeline";
import { normalizeSegments, newSegmentId, validateSegments, type Segment } from "../preview/model";

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
  playActiveSegment: (loop: boolean) => void;
  playOrderedSegments: () => void;
  pausePlayback: () => void;
  createClips: () => void | Promise<void>;
  onSegmentCommitted?: () => void;
}) {
  const [editorStatus, setEditorStatus] = createSignal("");
  const [segmentLabel, setSegmentLabel] = createSignal("");
  const [timecode, setTimecode] = createSignal("");
  const [activeSegmentIndex, setActiveIndex] = createSignal<number>();
  const [editingActive, setEditingActive] = createSignal(false);
  const [shortcutHelpOpen, setShortcutHelpOpen] = createSignal(false);
  const [timeline, setTimeline] = createSignal<TimelineHistory>(
    createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 }),
  );
  let selectedMediaId: string | undefined;
  const present = () => timeline().present;
  const playheadMs = () => present().playheadMs;
  const duration = () => deps.selected()?.durationMs ?? 0;
  const activeSegment = () => {
    const index = activeSegmentIndex();
    return index === undefined ? undefined : present().segments[index];
  };
  const editingInMs = () => (editingActive() ? activeSegment()?.startMs : present().inMs);
  const editingOutMs = () => (editingActive() ? activeSegment()?.endMs : present().outMs);
  const clearDraft = () => {
    const current = timeline();
    if (current.present.inMs === undefined && current.present.outMs === undefined) return;
    setTimeline(updateTimelineDraft(current, { inMs: undefined, outMs: undefined }));
  };
  const selectActiveSegment = (index?: number) => {
    if (index !== undefined && !present().segments[index]) return;
    setActiveIndex(index);
    setEditingActive(index !== undefined);
    clearDraft();
    if (index !== undefined) {
      deps.pausePlayback();
      const startMs = present().segments[index]?.startMs;
      if (startMs !== undefined) {
        const next = updateTimelineView(timeline(), { playheadMs: startMs });
        setTimeline(next);
        deps.setPreviewCenterMs(startMs);
      }
    }
  };
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
    const selectedID = activeSegment()?.id;
    setEditorStatus("");
    const { playheadMs: nextPlayheadMs, zoom: nextZoom, ...editChanges } = changes;
    const normalizedEditChanges = editChanges.segments
      ? {
          ...editChanges,
          segments: normalizeSegments(editChanges.segments, deps.selected()?.id ?? "media"),
        }
      : editChanges;
    let next = timeline();
    if (Object.keys(normalizedEditChanges).length) next = editTimeline(next, normalizedEditChanges);
    if (nextPlayheadMs !== undefined || nextZoom !== undefined)
      next = updateTimelineView(next, {
        ...(nextPlayheadMs !== undefined ? { playheadMs: nextPlayheadMs } : {}),
        ...(nextZoom !== undefined ? { zoom: nextZoom } : {}),
      });
    setTimeline(next);
    if (selectedID) {
      const nextIndex = next.present.segments.findIndex((segment) => segment.id === selectedID);
      if (nextIndex >= 0) {
        setActiveIndex(nextIndex);
      } else {
        setActiveIndex();
        setEditingActive(false);
      }
    }
    if (nextPlayheadMs !== undefined) deps.setPreviewCenterMs(next.present.playheadMs);
    if (Object.keys(normalizedEditChanges).length) {
      deps.pausePlayback();
      deps.markDirty();
    }
  };
  const updatePlaybackPosition = (positionMs: number) => {
    const nextPosition = Math.max(0, Math.min(duration(), Math.round(positionMs)));
    if (nextPosition !== present().playheadMs)
      setTimeline(updateTimelinePlayback(timeline(), nextPosition));
  };
  const setMarker = (kind: "inMs" | "outMs", value: number) => {
    setEditorStatus("");
    const active = activeSegmentIndex();
    if (active !== undefined && editingActive()) {
      const current = present().segments[active];
      if (!current) return selectActiveSegment();
      const boundary = kind === "inMs" ? "start" : "end";
      const nextValue = Math.round(value);
      if (!Number.isFinite(nextValue) || nextValue < 0 || nextValue > duration())
        return setEditorStatus("In must be before Out and both must be within the video.");
      const next = present().segments.map((segment, position) =>
        position === active
          ? { ...segment, [boundary === "start" ? "startMs" : "endMs"]: nextValue }
          : segment,
      );
      const error = validateSegments(next, duration());
      if (error)
        return setEditorStatus(
          error === "Segments cannot overlap."
            ? "That boundary would overlap another cut or leave In before Out."
            : error,
        );
      updateTimeline({ segments: next });
      return;
    }
    const currentIn = present().inMs;
    const currentOut = present().outMs;
    const nextValue = Math.round(value);
    if (
      !Number.isFinite(nextValue) ||
      nextValue < 0 ||
      nextValue > duration() ||
      (kind === "inMs" && currentOut !== undefined && nextValue >= currentOut) ||
      (kind === "outMs" && currentIn !== undefined && nextValue <= currentIn)
    )
      return setEditorStatus("In must be before Out and both must be within the video.");
    deps.pausePlayback();
    setTimeline(editTimeline(timeline(), { [kind]: nextValue }));
    deps.markDirty();
  };
  const previewMarker = (kind: "inMs" | "outMs", value: number) => {
    const active = activeSegmentIndex();
    if (active !== undefined && editingActive()) {
      previewSegment(active, {
        boundary: kind === "inMs" ? "start" : "end",
        valueMs: value,
      });
      return;
    }
    const currentIn = present().inMs;
    const currentOut = present().outMs;
    const nextValue = Math.round(value);
    if (
      !Number.isFinite(nextValue) ||
      nextValue < 0 ||
      nextValue > duration() ||
      (kind === "inMs" && currentOut !== undefined && nextValue >= currentOut) ||
      (kind === "outMs" && currentIn !== undefined && nextValue <= currentIn)
    )
      return;
    setTimeline({
      ...timeline(),
      present: { ...present(), [kind]: nextValue },
    });
  };
  const addSegment = () => {
    const item = deps.selected();
    if (editingActive())
      return setEditorStatus("Press Escape to leave active cut editing before creating a draft.");
    const { inMs, outMs } = present();
    if (!item || inMs === undefined || outMs === undefined || inMs >= outMs)
      return setEditorStatus("Set an in point before the out point.");
    const segment: Segment = {
      id: newSegmentId(),
      startMs: inMs,
      endMs: outMs,
      label: segmentLabel().trim() || undefined,
      included: true,
    };
    const next = [...present().segments, segment];
    const error = validateSegments(next, item.durationMs);
    if (error) return setEditorStatus(error);
    updateTimeline({ segments: next });
    clearDraft();
    setSegmentLabel("");
    setActiveIndex(next.length - 1);
    setEditingActive(false);
    deps.onSegmentCommitted?.();
  };
  const removeSegment = (index: number) => {
    const active = activeSegmentIndex();
    const next = removeSegments(present().segments, index);
    updateTimeline({ segments: next });
    if (active === index) selectActiveSegment();
  };
  const moveSegment = (index: number, direction: -1 | 1) => {
    const current = present().segments;
    const next = moveSegments(current, index, direction);
    updateTimeline({ segments: next });
  };
  type SegmentChange = { boundary: "start" | "end"; valueMs: number } | { startMs: number };
  const calculateSegmentUpdate = (index: number, change: SegmentChange) => {
    const current = present().segments;
    const next =
      "boundary" in change
        ? resizeSegmentInteractive(current, index, change.boundary, change.valueMs, duration())
        : moveSegmentTo(current, index, change.startMs, duration());
    return { current, next };
  };
  const updateSegment = (index: number, change: SegmentChange) => {
    const { current, next } = calculateSegmentUpdate(index, change);
    if (next === current) {
      const currentValue =
        "boundary" in change
          ? current[index]?.[change.boundary === "start" ? "startMs" : "endMs"]
          : current[index]?.startMs;
      if (
        currentValue !== undefined &&
        currentValue !== ("boundary" in change ? change.valueMs : change.startMs)
      )
        setEditorStatus("That edit would overlap another cut or leave In before Out.");
      return;
    }
    updateTimeline({ segments: next });
  };
  const previewSegment = (index: number, change: SegmentChange) => {
    const { current, next } = calculateSegmentUpdate(index, change);
    const preview =
      "boundary" in change
        ? resizeSegmentInteractive(current, index, change.boundary, change.valueMs, duration())
        : next;
    if (preview === current) return;
    setTimeline({
      ...timeline(),
      present: {
        ...present(),
        segments: normalizeSegments(preview, deps.selected()?.id ?? "media"),
      },
    });
  };
  const updateSegmentLabel = (index: number, label: string) =>
    updateTimeline({
      segments: present().segments.map((segment: Segment, position: number) =>
        position === index ? { ...segment, label: label.trim() || undefined } : segment,
      ),
    });
  const updateSegmentIncluded = (index: number, included: boolean) => {
    const segment = present().segments[index];
    if (!segment || (segment.included !== false) === included) return;
    updateTimeline({
      segments: present().segments.map((item: Segment, position: number) =>
        position === index ? { ...item, included } : item,
      ),
    });
  };
  const splitActiveSegment = () => {
    const index = activeSegmentIndex();
    if (index === undefined) return setEditorStatus("Select a cut before splitting it.");
    const next = splitSegment(present().segments, index, playheadMs());
    if (next === present().segments)
      return setEditorStatus("Place the playhead inside the active cut to split it.");
    updateTimeline({ segments: next });
    setActiveIndex(index + 1);
  };

  createEffect(() => {
    const item = deps.selected();
    if (item?.id === selectedMediaId) return;
    selectedMediaId = item?.id;
    setEditorStatus("");
    setActiveIndex();
    setEditingActive(false);
    clearDraft();
  });

  const undo = () => {
    const selectedID = activeSegment()?.id;
    const next = undoTimeline(timeline());
    if (next === timeline()) return;
    setTimeline(next);
    if (selectedID) {
      const nextIndex = next.present.segments.findIndex((segment) => segment.id === selectedID);
      if (nextIndex >= 0) setActiveIndex(nextIndex);
      else selectActiveSegment();
    } else if (activeSegmentIndex() !== undefined) selectActiveSegment();
    deps.setPreviewCenterMs(next.present.playheadMs);
    deps.markDirty();
  };
  const redo = () => {
    const selectedID = activeSegment()?.id;
    const next = redoTimeline(timeline());
    if (next === timeline()) return;
    setTimeline(next);
    if (selectedID) {
      const nextIndex = next.present.segments.findIndex((segment) => segment.id === selectedID);
      if (nextIndex >= 0) setActiveIndex(nextIndex);
      else selectActiveSegment();
    } else if (activeSegmentIndex() !== undefined) selectActiveSegment();
    deps.setPreviewCenterMs(next.present.playheadMs);
    deps.markDirty();
  };

  createEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isEditable = target.closest(
        "textarea, select, [contenteditable='true'], [role='combobox'], [role='menu'], [role='dialog'], dialog, .settings-view, [role='tablist'], input:not([type='range'])",
      );
      if (
        event.defaultPrevented ||
        isEditable ||
        ((event.ctrlKey || event.metaKey || event.altKey) &&
          !["z", "y"].includes(event.key.toLowerCase())) ||
        (event.key === " " && target.closest("button, a, summary"))
      )
        return;
      if (event.shiftKey && (event.key === "/" || event.key === "?")) {
        event.preventDefault();
        setShortcutHelpOpen(true);
      } else if (event.key === "," || event.key === ".") {
        event.preventDefault();
        const step = frameDuration(deps.selected()) || 1000;
        updateTimeline({
          playheadMs: Math.max(
            0,
            Math.min(duration(), playheadMs() + (event.key === "," ? -step : step)),
          ),
        });
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        updateTimeline({
          playheadMs: Math.max(
            0,
            Math.min(duration(), playheadMs() + (event.key === "ArrowLeft" ? -1000 : 1000)),
          ),
        });
      } else if (event.key === " ") {
        event.preventDefault();
        deps.togglePlayback();
      } else if (event.key.toLowerCase() === "i" || event.key.toLowerCase() === "o") {
        event.preventDefault();
        setMarker(event.key.toLowerCase() === "i" ? "inMs" : "outMs", deps.watchedPosition());
      } else if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        addSegment();
      } else if (event.key.toLowerCase() === "b") {
        event.preventDefault();
        splitActiveSegment();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        const index = activeSegmentIndex();
        if (index !== undefined) {
          event.preventDefault();
          removeSegment(index);
        }
      } else if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        deps.playActiveSegment(false);
      } else if (event.key.toLowerCase() === "l") {
        event.preventDefault();
        deps.playActiveSegment(true);
      } else if (event.key.toLowerCase() === "r") {
        event.preventDefault();
        deps.playOrderedSegments();
      } else if (event.key.toLowerCase() === "e") {
        event.preventDefault();
        void deps.createClips();
      } else if (event.key === "Escape") {
        if (activeSegmentIndex() !== undefined || editingActive()) {
          event.preventDefault();
          selectActiveSegment();
        }
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
  });

  return {
    editorStatus,
    setEditorStatus,
    segmentLabel,
    setSegmentLabel,
    timecode,
    setTimecode,
    timeline,
    setTimeline,
    activeSegmentIndex,
    setActiveSegmentIndex: selectActiveSegment,
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
    previewMarker,
    previewSegment,
    addSegment,
    removeSegment,
    moveSegment,
    updateSegment,
    updateSegmentLabel,
    updateSegmentIncluded,
    splitActiveSegment,
    undo,
    redo,
  };
}
