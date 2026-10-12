import { useAtomValue } from "@effect/atom-solid";
import * as Atom from "effect/reactivity/Atom";
import type { ServerState } from "../../app/server";
import { syncCommand } from "../../app/syncCommand";
import type * as EffectApiTypes from "../../generated/effect-api";
import { type Accessor, type Setter } from "solid-js";
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
import {
  nextSegmentName,
  normalizeSegments,
  newSegmentId,
  parseTimecode,
  validateSegmentLabel,
  validateSegments,
  type Segment,
} from "../preview/model";

type Media = EffectApiTypes.Media;
type Track = {
  index: number;
  type: string;
  codec: string;
  language?: string;
  disposition?: string[];
};

export function createEditorController(deps: {
  server: ServerState;
  timelineAtom?: Atom.Writable<TimelineHistory>;
  selected: Accessor<Media | undefined>;
  segmentIdentityScope?: Accessor<string | undefined>;
  setStatus: Setter<string>;
  markDirty: () => void;
  setPreviewCenterMs: (ms: number) => void;
  watchedPosition: Accessor<number>;
  togglePlayback: () => void;
  playActiveSegment: (loop: boolean) => void;
  playOrderedSegments: () => void;
  pausePlayback: () => void;
  createClips: () => void;
  shortcutHelpOpen: Accessor<boolean>;
  setShortcutHelpOpen: (open: boolean) => void;
  onSegmentCommitted?: () => void;
}) {
  const { registry } = deps.server;
  const interactionAtom = Atom.keepAlive(
    Atom.make({
      selectedId: undefined as string | undefined,
      status: "",
      discardedMarks: false,
      boundaryDrafts: {} as Record<string, Partial<Record<"start" | "end", string>>>,
      boundaryErrors: {} as Record<string, string>,
      labelDrafts: {} as Record<string, string>,
      labelErrors: {} as Record<string, string>,
    }),
  );
  const observedInteraction = useAtomValue(() => interactionAtom);
  const interaction = () => {
    observedInteraction();
    return registry.get(interactionAtom);
  };
  const editorStatus = () => interaction().status;
  const boundaryDrafts = () => interaction().boundaryDrafts;
  const boundaryErrors = () => interaction().boundaryErrors;
  const labelDrafts = () => interaction().labelDrafts;
  const labelErrors = () => interaction().labelErrors;
  // History, drafts and drag observations live until the workspace registry is disposed.
  const timelineAtom =
    deps.timelineAtom ??
    Atom.keepAlive(
      Atom.make<TimelineHistory>(createTimelineHistory({ playheadMs: 0, segments: [], zoom: 1 })),
    );
  const dragOrigin = Atom.keepAlive(Atom.make<TimelineHistory | undefined>(undefined));
  const observedTimeline = useAtomValue(() => timelineAtom);
  const timeline = () => {
    observedTimeline();
    return registry.get(timelineAtom);
  };
  const writeTimeline = syncCommand<TimelineHistory, void>(
    registry,
    (value) => {
      const segments = registry.get(timelineAtom).present.segments;
      registry.set(timelineAtom, value);
      if (value.present.segments === segments) return;
      const ids = new Set(value.present.segments.map((segment) => segment.id));
      const retain = <A>(drafts: Record<string, A>) =>
        Object.fromEntries(Object.entries(drafts).filter(([id]) => ids.has(id)));
      registry.update(interactionAtom, (state) => ({
        ...state,
        selectedId: ids.has(state.selectedId) ? state.selectedId : undefined,
        boundaryDrafts: retain(state.boundaryDrafts),
        boundaryErrors: retain(state.boundaryErrors),
        labelDrafts: retain(state.labelDrafts),
        labelErrors: retain(state.labelErrors),
      }));
    },
    () => new Error("Unable to update the editor timeline."),
  );
  // Local synchronous edits use runtime-owned command atoms; asynchronous work stays in Effect commands.

  const setEditorStatus = (status: string) => {
    registry.update(interactionAtom, (value) => ({ ...value, status }));
  };
  const setActiveIndex = (index?: number) =>
    registry.update(interactionAtom, (value) => ({
      ...value,
      selectedId: index === undefined ? undefined : present().segments[index]?.id,
    }));
  const clearInputDrafts = () =>
    registry.update(interactionAtom, (value) => ({
      ...value,
      boundaryDrafts: {},
      boundaryErrors: {},
      labelDrafts: {},
      labelErrors: {},
    }));
  const replaceTimeline = (value: TimelineHistory) => {
    registry.set(dragOrigin, undefined);
    const hadDraft = present().inMs !== undefined || present().outMs !== undefined;
    setActiveIndex();
    clearInputDrafts();
    setEditorStatus(
      hadDraft || interaction().discardedMarks
        ? "Incomplete marks were discarded when switching media."
        : "",
    );
    registry.update(interactionAtom, (state) => ({ ...state, discardedMarks: false }));
    writeTimeline(value);
  };
  const segmentIdentityScope = deps.segmentIdentityScope ?? (() => deps.selected()?.id);
  const present = () => timeline().present;
  const playheadMs = () => present().playheadMs;
  const duration = () => deps.selected()?.durationMs ?? 0;
  const activeSegmentIndex = () => {
    const id = interaction().selectedId;
    const index =
      id === undefined ? -1 : present().segments.findIndex((segment) => segment.id === id);
    return index < 0 ? undefined : index;
  };
  const activeSegment = () => {
    const id = interaction().selectedId;
    return id === undefined ? undefined : present().segments.find((segment) => segment.id === id);
  };
  const editingActive = () => activeSegmentIndex() !== undefined;
  const editingInMs = () => (editingActive() ? activeSegment()?.startMs : present().inMs);
  const editingOutMs = () => (editingActive() ? activeSegment()?.endMs : present().outMs);
  const clearDraft = () => {
    const current = timeline();
    if (current.present.inMs === undefined && current.present.outMs === undefined) return;
    writeTimeline(updateTimelineDraft(current, { inMs: undefined, outMs: undefined }));
  };
  const selectActiveSegment = (index?: number) => {
    if (index !== undefined && !present().segments[index]) return;
    setActiveIndex(index);
    clearDraft();
    if (index !== undefined) {
      deps.pausePlayback();
      const startMs = present().segments[index]?.startMs;
      if (startMs !== undefined) {
        const next = updateTimelineView(timeline(), { playheadMs: startMs });
        writeTimeline(next);
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
    setEditorStatus("");
    const { playheadMs: nextPlayheadMs, zoom: nextZoom, ...editChanges } = changes;
    const normalizedEditChanges = editChanges.segments
      ? {
          ...editChanges,
          segments: normalizeSegments(editChanges.segments, segmentIdentityScope() ?? "media"),
        }
      : editChanges;
    const before = timeline();
    let next = before;
    if (Object.keys(normalizedEditChanges).length) next = editTimeline(next, normalizedEditChanges);
    const committed = next !== before;
    if (nextPlayheadMs !== undefined || nextZoom !== undefined)
      next = updateTimelineView(next, {
        ...(nextPlayheadMs !== undefined ? { playheadMs: nextPlayheadMs } : {}),
        ...(nextZoom !== undefined ? { zoom: nextZoom } : {}),
      });
    writeTimeline(next);
    if (nextPlayheadMs !== undefined) deps.setPreviewCenterMs(next.present.playheadMs);
    if (committed) {
      deps.pausePlayback();
      deps.markDirty();
    }
  };
  const updatePlaybackPosition = (positionMs: number) => {
    const nextPosition = Math.max(0, Math.min(duration(), Math.round(positionMs)));
    if (nextPosition !== present().playheadMs)
      writeTimeline(updateTimelinePlayback(timeline(), nextPosition));
  };
  const setMarker = (kind: "inMs" | "outMs", value: number) => {
    setEditorStatus("");
    const active = activeSegmentIndex();
    const nextValue = Math.round(value);
    if (!Number.isFinite(nextValue) || nextValue < 0 || nextValue > duration())
      return setEditorStatus("In must be before Out and both must be within the video.");
    if (active !== undefined && editingActive()) {
      const current = present().segments[active];
      if (!current) return selectActiveSegment();
      const boundary = kind === "inMs" ? "start" : "end";
      const next = present().segments.map((segment: Segment, position: number) =>
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
    const draftIn = kind === "inMs" ? nextValue : currentIn;
    const draftOut = kind === "outMs" ? nextValue : currentOut;
    if (
      (kind === "inMs" && currentOut !== undefined && nextValue >= currentOut) ||
      (kind === "outMs" && currentIn !== undefined && nextValue <= currentIn)
    )
      return setEditorStatus("In must be before Out and both must be within the video.");
    deps.pausePlayback();
    if (draftIn === undefined || draftOut === undefined) {
      writeTimeline(updateTimelineDraft(timeline(), { inMs: draftIn, outMs: draftOut }));
      return;
    }

    const segment: Segment = {
      id: newSegmentId(),
      startMs: draftIn,
      endMs: draftOut,
      label: nextSegmentName(present().segments),
      included: true,
    };
    const nextSegments = [...present().segments, segment];
    const error = validateSegments(nextSegments, duration());
    if (error)
      return setEditorStatus(
        error === "Segments cannot overlap."
          ? "That range would overlap another cut. Choose a different range."
          : error,
      );
    writeTimeline(
      editTimeline(timeline(), {
        segments: nextSegments,
        inMs: undefined,
        outMs: undefined,
      }),
    );
    setActiveIndex(nextSegments.length - 1);
    deps.markDirty();
    deps.onSegmentCommitted?.();
  };
  /** Start a fresh range when the user presses Start after a completed cut.
   * Boundary inputs intentionally continue to use setMarker so existing cuts can be edited.
   */
  const startSegmentAt = (value: number) => {
    const nextValue = Math.round(value);
    if (!Number.isFinite(nextValue) || nextValue < 0 || nextValue > duration())
      return setEditorStatus("In must be before Out and both must be within the video.");
    setEditorStatus("");
    deps.pausePlayback();
    setActiveIndex();
    writeTimeline(updateTimelineDraft(timeline(), { inMs: nextValue, outMs: undefined }));
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
    writeTimeline({
      ...timeline(),
      present: { ...present(), [kind]: nextValue },
    });
  };
  const beginDrag = () => {
    if (!registry.get(dragOrigin)) registry.set(dragOrigin, timeline());
  };
  const cancelDrag = () => {
    const original = registry.get(dragOrigin);
    registry.set(dragOrigin, undefined);
    if (original) writeTimeline(original);
  };
  const commitDrag = (kind: "playhead" | "draft-in" | "draft-out" | "segment") => {
    const original = registry.get(dragOrigin);
    if (!original) return;
    const edited = present();
    cancelDrag();
    if (kind === "playhead") updateTimeline({ playheadMs: edited.playheadMs });
    else if (kind === "draft-in" && edited.inMs !== undefined) setMarker("inMs", edited.inMs);
    else if (kind === "draft-out" && edited.outMs !== undefined) setMarker("outMs", edited.outMs);
    else if (kind === "segment") updateTimeline({ segments: edited.segments });
  };
  const addSegment = () => {
    if (editingActive()) return setEditorStatus("Choose New segment before starting another cut.");
    const { inMs, outMs } = present();
    if (inMs === undefined || outMs === undefined || inMs >= outMs)
      return setEditorStatus("Set an In point and an Out point to create a cut.");
    setMarker("outMs", outMs);
  };
  const newSegment = () => {
    setEditorStatus("");
    deps.pausePlayback();
    setActiveIndex();
    clearDraft();
    clearInputDrafts();
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
  const updateSegmentBoundary = (index: number, boundary: "start" | "end", valueMs: number) => {
    const segment = present().segments[index];
    if (!segment || !Number.isInteger(valueMs) || valueMs < 0 || valueMs > duration()) {
      setEditorStatus("In must be before Out and both must be within the video.");
      return false;
    }
    const currentValue = boundary === "start" ? segment.startMs : segment.endMs;
    if (currentValue === valueMs) {
      setEditorStatus("");
      return true;
    }
    const next = present().segments.map((item: Segment, position: number) =>
      position === index
        ? { ...item, [boundary === "start" ? "startMs" : "endMs"]: valueMs }
        : item,
    );
    if (validateSegments(next, duration())) {
      setEditorStatus("That boundary would overlap another cut or leave In before Out.");
      return false;
    }
    updateTimeline({ segments: next });
    return true;
  };
  const previewSegment = (index: number, change: SegmentChange) => {
    const { current, next } = calculateSegmentUpdate(index, change);
    const preview =
      "boundary" in change
        ? resizeSegmentInteractive(current, index, change.boundary, change.valueMs, duration())
        : next;
    if (preview === current) return;
    writeTimeline({
      ...timeline(),
      present: {
        ...present(),
        segments: normalizeSegments(preview, segmentIdentityScope() ?? "media"),
      },
    });
  };
  const updateSegmentLabel = (index: number, label: string) => {
    const error = validateSegmentLabel(label);
    if (error) {
      setEditorStatus(error);
      return false;
    }
    setEditorStatus("");
    updateTimeline({
      segments: present().segments.map((segment: Segment, position: number) =>
        position === index ? { ...segment, label: label.trim() || undefined } : segment,
      ),
    });
    return true;
  };
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

  const setBoundaryDraft = (id: string, boundary: "start" | "end", draft: string) => {
    registry.update(interactionAtom, (value) => ({
      ...value,
      boundaryDrafts: {
        ...value.boundaryDrafts,
        [id]: { ...value.boundaryDrafts[id], [boundary]: draft },
      },
    }));
  };
  const cancelBoundary = (id: string, boundary: "start" | "end") => {
    registry.update(interactionAtom, (value) => {
      const boundaryErrors = { ...value.boundaryErrors };
      delete boundaryErrors[id];
      return {
        ...value,
        boundaryErrors,
        boundaryDrafts: {
          ...value.boundaryDrafts,
          [id]: { ...value.boundaryDrafts[id], [boundary]: undefined },
        },
      };
    });
  };
  const confirmBoundary = (id: string, boundary: "start" | "end") => {
    const draft = interaction().boundaryDrafts[id]?.[boundary];
    if (draft === undefined) return;
    const index = present().segments.findIndex((segment) => segment.id === id);
    if (index < 0) return;
    const value = parseTimecode(draft);
    if (value !== undefined && updateSegmentBoundary(index, boundary, value)) {
      cancelBoundary(id, boundary);
      return;
    }
    const message =
      value === undefined ? "Enter a valid timecode within this video." : editorStatus();
    registry.update(interactionAtom, (value) => ({
      ...value,
      boundaryErrors: { ...value.boundaryErrors, [id]: message },
    }));
  };
  const editLabelDraft = (id: string, label: string) => {
    const index = present().segments.findIndex((segment) => segment.id === id);
    if (index < 0) return;
    const error = validateSegmentLabel(label);
    registry.update(interactionAtom, (value) => {
      const labelErrors = { ...value.labelErrors };
      if (error) labelErrors[id] = error;
      else delete labelErrors[id];
      return { ...value, labelErrors, labelDrafts: { ...value.labelDrafts, [id]: label } };
    });
    if (error) setEditorStatus(error);
    else updateSegmentLabel(index, label);
  };
  const commitLabelDraft = (id: string) => {
    if (validateSegmentLabel(interaction().labelDrafts[id] ?? "")) return;
    registry.update(interactionAtom, (value) => {
      const labelDrafts = { ...value.labelDrafts };
      delete labelDrafts[id];
      return { ...value, labelDrafts };
    });
  };

  const prepareMediaSwitch = () => {
    cancelDrag();
    const hadDraft = present().inMs !== undefined || present().outMs !== undefined;
    clearDraft();
    setActiveIndex();
    clearInputDrafts();
    registry.update(interactionAtom, (state) => ({ ...state, discardedMarks: hadDraft }));
    setEditorStatus(hadDraft ? "Incomplete marks were discarded when switching media." : "");
  };

  const syncHistorySelection = (
    previous: TimelineHistory,
    next: TimelineHistory,
    selectedID: string | undefined,
  ) => {
    let nextIndex = selectedID
      ? next.present.segments.findIndex((segment: Segment) => segment.id === selectedID)
      : -1;
    if (nextIndex < 0)
      nextIndex = next.present.segments.findIndex(
        (segment) => !previous.present.segments.some((item) => item.id === segment.id),
      );
    if (nextIndex >= 0) {
      setActiveIndex(nextIndex);
    } else {
      setActiveIndex();
    }
  };
  const applyHistoryTransition = (transition: (history: TimelineHistory) => TimelineHistory) => {
    const current = timeline();
    const selectedID = activeSegment()?.id;
    const next = transition(current);
    if (next === current) return;
    writeTimeline(next);
    clearInputDrafts();
    syncHistorySelection(current, next, selectedID);
    deps.setPreviewCenterMs(next.present.playheadMs);
    deps.markDirty();
  };
  const undo = () => applyHistoryTransition(undoTimeline);
  const redo = () => applyHistoryTransition(redoTimeline);

  const dispatchShortcut = (event: {
    key: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
  }) => {
    if (event.shiftKey && (event.key === "/" || event.key === "?")) {
      deps.setShortcutHelpOpen(true);
    } else if (event.key === "," || event.key === ".") {
      const step = frameDuration(deps.selected()) || 1000;
      updateTimeline({
        playheadMs: Math.max(
          0,
          Math.min(duration(), playheadMs() + (event.key === "," ? -step : step)),
        ),
      });
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      updateTimeline({
        playheadMs: Math.max(
          0,
          Math.min(duration(), playheadMs() + (event.key === "ArrowLeft" ? -1000 : 1000)),
        ),
      });
    } else if (event.key === " ") {
      deps.togglePlayback();
    } else if (event.key.toLowerCase() === "i" || event.key.toLowerCase() === "o") {
      if (event.key.toLowerCase() === "i") startSegmentAt(deps.watchedPosition());
      else setMarker("outMs", deps.watchedPosition());
    } else if (event.key.toLowerCase() === "c") {
      newSegment();
    } else if (event.key.toLowerCase() === "b") {
      splitActiveSegment();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      const index = activeSegmentIndex();
      if (index === undefined) return false;
      removeSegment(index);
    } else if (event.key.toLowerCase() === "p") {
      deps.playActiveSegment(false);
    } else if (event.key.toLowerCase() === "l") {
      deps.playActiveSegment(true);
    } else if (event.key.toLowerCase() === "r") {
      deps.playOrderedSegments();
    } else if (event.key.toLowerCase() === "e") {
      void deps.createClips();
    } else if (event.key === "Escape") {
      if (
        activeSegmentIndex() !== undefined ||
        editingActive() ||
        present().inMs !== undefined ||
        present().outMs !== undefined
      ) {
        newSegment();
      } else return false;
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      if (event.shiftKey) redo();
      else undo();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
      redo();
    } else return false;
    return true;
  };
  return {
    dispatchShortcut,
    editorStatus,
    setEditorStatus,
    interactionAtom,
    boundaryDrafts,
    boundaryErrors,
    labelDrafts,
    labelErrors,
    setBoundaryDraft,
    confirmBoundary,
    cancelBoundary,
    editLabelDraft,
    commitLabelDraft,
    timeline,
    timelineAtom,
    replaceTimeline,
    beginDrag,
    commitDrag,
    cancelDrag,
    activeSegmentIndex,
    setActiveSegmentIndex: selectActiveSegment,
    activeSegment,
    editingActive,
    editingInMs,
    editingOutMs,
    shortcutHelpOpen: deps.shortcutHelpOpen,
    setShortcutHelpOpen: deps.setShortcutHelpOpen,
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
    prepareMediaSwitch,
    undo,
    redo,
  };
}
