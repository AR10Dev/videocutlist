import { createControllerTestRoot } from "./controllerTestEnvironment";
import type * as EffectApiTypes from "../src/generated/effect-api";
import { createRoot, createSignal, onCleanup } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createEditorController } from "../src/features/editor/controller";

type Media = EffectApiTypes.Media;

const media: Media = {
  id: "m_0123456789012345678901234567890123456789012",
  name: "camera.mp4",
  durationMs: 10_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
};

const setup = () => {
  const { value, dispose } = createControllerTestRoot(({ registry, server }) => {
    const [selected, setSelected] = createSignal<Media | undefined>(media);
    const [, setStatus] = createSignal("");
    const [shortcutHelpOpen, setShortcutHelpOpen] = createSignal(false);
    let dirty = 0;
    let committed = 0;
    let disposeEditor!: () => void;
    let editorRootDisposed = false;
    const controller = createRoot((cleanup) => {
      disposeEditor = cleanup;
      onCleanup(() => (editorRootDisposed = true));
      return createEditorController({
        server,
        selected,
        setStatus,
        markDirty: () => {
          dirty += 1;
        },
        setPreviewCenterMs: () => undefined,
        watchedPosition: () => 0,
        togglePlayback: () => undefined,
        playActiveSegment: () => undefined,
        playOrderedSegments: () => undefined,
        pausePlayback: () => undefined,
        createClips: () => undefined,
        shortcutHelpOpen,
        setShortcutHelpOpen,
        onSegmentCommitted: () => {
          committed += 1;
        },
      });
    });
    onCleanup(disposeEditor);
    return {
      controller,
      disposeEditor,
      editorRootDisposed: () => editorRootDisposed,
      dirty: () => dirty,
      committed: () => committed,
      setSelected,
      shortcutHelpOpen,
      registry,
      server,
    };
  });
  return { ...value, dispose };
};

it("applies local edits synchronously without server requests or unbounded command growth", () => {
  const { controller, registry, dispose } = setup();
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    controller.present();
    const nodes = registry.getNodes().size;
    for (let index = 0; index < 12; index++) {
      controller.setMarker("inMs", 100 + index);
      controller.setMarker("outMs", 300 + index);
    }
    expect(controller.present().segments).toMatchObject([{ startMs: 111, endMs: 311 }]);
    expect(registry.getNodes().size).toBeLessThanOrEqual(nodes + 2);
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    fetch.mockRestore();
    dispose();
  }
});

it("disposes its independently owned editor root with the provider root", () => {
  const { dispose, editorRootDisposed } = setup();
  expect(editorRootDisposed()).toBe(false);
  dispose();
  expect(editorRootDisposed()).toBe(true);
});

describe("automatic segment editing", () => {
  it("creates one selected segment, updates it, and starts a new draft", () => {
    const { controller, dirty, committed, dispose } = setup();
    controller.setMarker("inMs", 100);
    expect(controller.present().segments).toHaveLength(0);
    controller.setMarker("outMs", 300);
    const first = controller.present().segments[0];
    expect(first).toMatchObject({ startMs: 100, endMs: 300, label: "Segment 001" });
    expect(controller.activeSegmentIndex()).toBe(0);
    expect(committed()).toBe(1);

    controller.setMarker("outMs", 400);
    expect(controller.present().segments).toHaveLength(1);
    expect(controller.present().segments[0]).toMatchObject({ id: first.id, endMs: 400 });

    controller.newSegment();
    controller.setMarker("inMs", 500);
    controller.setMarker("outMs", 700);
    expect(controller.present().segments).toHaveLength(2);
    expect(controller.present().segments[1]).toMatchObject({ label: "Segment 002" });
    expect(dirty()).toBe(3);
    dispose();
  });

  it("starts a second draft when Start is pressed after a completed cut", () => {
    const { controller, dispose } = setup();
    controller.setMarker("inMs", 100);
    controller.setMarker("outMs", 300);

    controller.startSegmentAt(500);
    expect(controller.present().segments).toHaveLength(1);
    expect(controller.present().segments[0]).toMatchObject({ startMs: 100, endMs: 300 });
    expect(controller.present().inMs).toBe(500);
    expect(controller.present().outMs).toBeUndefined();
    expect(controller.activeSegmentIndex()).toBeUndefined();

    controller.setMarker("outMs", 700);
    expect(controller.present().segments).toHaveLength(2);
    expect(controller.present().segments[1]).toMatchObject({ startMs: 500, endMs: 700 });

    expect(controller.updateSegmentBoundary(0, "start", 120)).toBe(true);
    expect(controller.present().segments[0]).toMatchObject({ startMs: 120, endMs: 300 });
    dispose();
  });

  it("rejects invalid typed boundaries without changing the committed segment", () => {
    const { controller, dispose } = setup();
    controller.setMarker("inMs", 100);
    controller.setMarker("outMs", 300);
    const before = controller.present().segments[0];

    expect(controller.updateSegmentBoundary(0, "end", 50)).toBe(false);
    expect(controller.present().segments[0]).toEqual(before);
    expect(controller.editorStatus()).toContain("overlap");

    expect(controller.updateSegmentBoundary(0, "end", 450)).toBe(true);
    expect(controller.present().segments[0]).toMatchObject({ id: before.id, endMs: 450 });
    dispose();
  });

  it("restores the preceding draft and identity through undo and redo", () => {
    const { controller, dispose } = setup();
    controller.setMarker("inMs", 100);
    controller.setMarker("outMs", 300);
    const firstId = controller.present().segments[0].id;
    controller.newSegment();
    controller.setMarker("inMs", 500);
    controller.setMarker("outMs", 700);
    const second = controller.present().segments[1];

    controller.undo();
    expect(controller.present().segments).toHaveLength(1);
    expect(controller.present().inMs).toBe(500);
    expect(controller.present().outMs).toBeUndefined();
    expect(controller.activeSegmentIndex()).toBeUndefined();

    controller.redo();
    expect(controller.present().segments[0].id).toBe(firstId);
    expect(controller.present().segments[1]).toEqual(second);
    expect(controller.activeSegmentIndex()).toBe(1);
    dispose();
  });

  it("does not mark an unchanged cut list dirty or lose redo history", () => {
    const { controller, dirty, dispose } = setup();
    controller.setMarker("inMs", 100);
    controller.setMarker("outMs", 300);
    controller.undo();
    const dirtyBefore = dirty();
    const futureBefore = controller.timeline().future;

    controller.updateTimeline({ segments: controller.present().segments });
    controller.moveSegment(0, 1);
    controller.removeSegment(0);

    expect(dirty()).toBe(dirtyBefore);
    expect(controller.timeline().future).toEqual(futureBefore);
    controller.redo();
    expect(controller.present().segments).toHaveLength(1);
    dispose();
  });

  it("separates no-op edits, view/playback observations, and committed document changes", () => {
    const { controller, dirty, dispose } = setup();
    try {
      controller.setMarker("inMs", 100);
      controller.setMarker("outMs", 300);
      const history = controller.timeline();
      controller.updateTimeline({
        segments: controller.present().segments,
        playheadMs: 200,
        zoom: 2,
      });
      controller.updatePlaybackPosition(250);
      expect(dirty()).toBe(1);
      expect(controller.timeline().past).toEqual(history.past);
      controller.updateSegmentLabel(0, "Renamed");
      controller.updateSegmentLabel(0, "Renamed");
      expect(dirty()).toBe(2);
      expect(controller.timeline().past).toHaveLength(2);
      controller.updateSegmentIncluded(0, false);
      controller.updateSegmentIncluded(0, false);
      expect(dirty()).toBe(3);
    } finally {
      dispose();
    }
  });

  it("preserves interaction state during playback and view updates, but prunes deleted cuts", () => {
    const { controller, registry, dirty, dispose } = setup();
    try {
      controller.setMarker("inMs", 100);
      controller.setMarker("outMs", 300);
      const id = controller.activeSegment()!.id!;
      controller.setBoundaryDraft(id, "start", "invalid");
      controller.confirmBoundary(id, "start");
      controller.editLabelDraft(id, "x".repeat(201));
      const interaction = registry.get(controller.interactionAtom);
      const history = controller.timeline();

      controller.updatePlaybackPosition(250);
      expect(registry.get(controller.interactionAtom)).toBe(interaction);
      controller.updateTimeline({ playheadMs: 400, zoom: 2 });

      expect(controller.playheadMs()).toBe(400);
      expect(controller.present().zoom).toBe(2);
      expect(controller.boundaryDrafts()).toBe(interaction.boundaryDrafts);
      expect(controller.boundaryErrors()).toBe(interaction.boundaryErrors);
      expect(controller.labelDrafts()).toBe(interaction.labelDrafts);
      expect(controller.labelErrors()).toBe(interaction.labelErrors);
      expect(controller.timeline().past).toBe(history.past);
      expect(dirty()).toBe(1);

      controller.removeSegment(0);
      expect(controller.activeSegment()).toBeUndefined();
      expect(controller.boundaryDrafts()).toEqual({});
      expect(controller.boundaryErrors()).toEqual({});
      expect(controller.labelDrafts()).toEqual({});
      expect(controller.labelErrors()).toEqual({});
    } finally {
      dispose();
    }
  });

  it("rejects incomplete, invalid and overlapping markers without committing", () => {
    const { controller, dirty, committed, dispose } = setup();
    try {
      controller.setMarker("inMs", 100);
      controller.setMarker("outMs", 50);
      expect(dirty()).toBe(0);
      expect(committed()).toBe(0);
      controller.setMarker("outMs", 300);
      controller.newSegment();
      controller.setMarker("inMs", 200);
      controller.setMarker("outMs", 400);
      expect(controller.editorStatus()).toContain("overlap");
      expect(controller.present().segments).toHaveLength(1);
      expect(controller.present().inMs).toBe(200);
      expect(dirty()).toBe(1);
      expect(committed()).toBe(1);
    } finally {
      dispose();
    }
  });

  it("owns drag previews, cancellation and one history commit", () => {
    const { controller, dirty, dispose } = setup();
    try {
      controller.setMarker("inMs", 100);
      controller.setMarker("outMs", 300);
      const original = controller.timeline();
      controller.beginDrag();
      controller.beginDrag(); // Duplicate mouse/pointer start does not replace the baseline.
      controller.previewSegment(0, { boundary: "end", valueMs: 400 });
      controller.previewSegment(0, { boundary: "end", valueMs: 500 });
      expect(controller.present().segments[0].endMs).toBe(500);
      expect(controller.timeline().past).toEqual(original.past);
      expect(dirty()).toBe(1);
      controller.commitDrag("segment");
      controller.commitDrag("segment");
      expect(dirty()).toBe(2);
      expect(controller.timeline().past).toHaveLength(2);
      controller.undo();
      expect(controller.present().segments[0]).toEqual(original.present.segments[0]);
      controller.redo();
      expect(controller.present().segments[0].endMs).toBe(500);
      const committed = controller.timeline();
      controller.beginDrag();
      controller.previewSegment(0, { startMs: 1000 });
      controller.cancelDrag();
      expect(controller.timeline()).toBe(committed);
      expect(dirty()).toBe(4);
      controller.beginDrag();
      controller.commitDrag("segment");
      expect(dirty()).toBe(4);
    } finally {
      dispose();
    }
  });

  it("commits a completed drag draft once and keeps playhead drags outside history", () => {
    const { controller, dirty, committed, dispose } = setup();
    try {
      controller.setMarker("inMs", 100);
      controller.beginDrag();
      controller.previewMarker("outMs", 300);
      expect(controller.present().segments).toHaveLength(0);
      controller.commitDrag("draft-out");
      expect(committed()).toBe(1);
      expect(dirty()).toBe(1);
      expect(controller.present().inMs).toBeUndefined();
      controller.beginDrag();
      controller.updateTimeline({ playheadMs: 400 });
      controller.commitDrag("playhead");
      expect(controller.playheadMs()).toBe(400);
      expect(dirty()).toBe(1);
      expect(controller.timeline().past).toHaveLength(1);
    } finally {
      dispose();
    }
  });

  it("retains history without subscribers and isolates workspace documents", async () => {
    vi.useFakeTimers();
    const a = setup();
    const b = setup();
    try {
      const release = a.registry.subscribe(a.controller.timelineAtom, () => undefined);
      a.controller.setMarker("inMs", 100);
      a.controller.setMarker("outMs", 300);
      release();
      a.disposeEditor();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(a.registry.get(a.controller.timelineAtom).present.segments).toHaveLength(1);
      expect(b.registry.get(b.controller.timelineAtom).present.segments).toEqual([]);
      a.controller.beginDrag();
      a.controller.previewSegment(0, { startMs: 1000 });
      const replacement = b.controller.timeline();
      a.controller.replaceTimeline(replacement);
      a.controller.commitDrag("segment");
      expect(a.controller.timeline()).toBe(replacement);
    } finally {
      a.dispose();
      b.dispose();
      vi.useRealTimers();
    }
  });

  it("retains interaction drafts and notices without subscribers and isolates workspaces", async () => {
    vi.useFakeTimers();
    const a = setup();
    const b = setup();
    try {
      a.controller.setMarker("inMs", 100);
      a.controller.setMarker("outMs", 300);
      const id = a.controller.activeSegment()!.id!;
      a.controller.setBoundaryDraft(id, "start", "invalid");
      a.controller.confirmBoundary(id, "start");
      a.controller.editLabelDraft(id, "working name");
      a.controller.setEditorStatus("Retained notice");
      a.disposeEditor();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(a.controller.activeSegment()?.id).toBe(id);
      expect(a.controller.boundaryDrafts()[id]?.start).toBe("invalid");
      expect(a.controller.boundaryErrors()[id]).toContain("valid timecode");
      expect(a.controller.labelDrafts()[id]).toBe("working name");
      expect(a.controller.editorStatus()).toBe("Retained notice");
      expect(b.controller.boundaryDrafts()).toEqual({});
      expect(b.controller.activeSegment()).toBeUndefined();
    } finally {
      a.dispose();
      b.dispose();
      vi.useRealTimers();
    }
  });

  it("resolves selection and input commands by identity through reorder, history and deletion", () => {
    const { controller, dispose } = setup();
    try {
      controller.setMarker("inMs", 100);
      controller.setMarker("outMs", 300);
      const first = controller.activeSegment()!.id!;
      controller.newSegment();
      controller.setMarker("inMs", 500);
      controller.setMarker("outMs", 700);
      controller.setActiveSegmentIndex(0);
      controller.setBoundaryDraft(first, "start", "00:00.120");
      controller.moveSegment(0, 1);
      expect(controller.activeSegmentIndex()).toBe(1);
      controller.confirmBoundary(first, "start");
      expect(controller.activeSegment()?.startMs).toBe(120);
      controller.undo();
      expect(controller.activeSegment()?.id).toBe(first);
      expect(controller.boundaryDrafts()).toEqual({});
      controller.undo();
      expect(controller.activeSegmentIndex()).toBe(0);
      controller.redo();
      expect(controller.activeSegmentIndex()).toBe(1);
      controller.setBoundaryDraft(first, "end", "invalid");
      controller.removeSegment(1);
      expect(controller.activeSegment()).toBeUndefined();
      expect(controller.boundaryDrafts()).toEqual({});
    } finally {
      dispose();
    }
  });

  it("cancels input drafts without blur committing and resets interaction on replacement", () => {
    const { controller, dispose } = setup();
    try {
      controller.setMarker("inMs", 100);
      controller.setMarker("outMs", 300);
      const id = controller.activeSegment()!.id!;
      controller.setBoundaryDraft(id, "start", "00:00.200");
      controller.cancelBoundary(id, "start");
      controller.confirmBoundary(id, "start");
      expect(controller.activeSegment()?.startMs).toBe(100);
      controller.editLabelDraft(id, "draft label");
      controller.replaceTimeline(controller.timeline());
      expect(controller.activeSegment()).toBeUndefined();
      expect(controller.labelDrafts()).toEqual({});
      controller.startSegmentAt(500);
      controller.prepareMediaSwitch();
      controller.replaceTimeline({
        past: [],
        future: [],
        present: { playheadMs: 0, segments: [], zoom: 1 },
      });
      expect(controller.editorStatus()).toContain("Incomplete marks were discarded");
    } finally {
      dispose();
    }
  });

  it("discards an incomplete draft before switching media", async () => {
    const { controller, setSelected, dispose } = setup();
    controller.setMarker("inMs", 100);
    controller.prepareMediaSwitch();
    setSelected({ ...media, id: "m_9876543210987654321098765432109876543210987" });
    await Promise.resolve();

    expect(controller.present().inMs).toBeUndefined();
    expect(controller.present().outMs).toBeUndefined();
    expect(controller.editorStatus()).toContain("Incomplete marks were discarded");
    dispose();
  });
});
