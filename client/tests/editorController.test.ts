import { createRoot, createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import type { components } from "../src/generated/api";
import { createEditorController } from "../src/features/editor/controller";

type Media = components["schemas"]["Media"];

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
  let dispose!: () => void;
  const value = createRoot((cleanup) => {
    dispose = cleanup;
    const [selected, setSelected] = createSignal<Media | undefined>(media);
    const [, setStatus] = createSignal("");
    let dirty = 0;
    let committed = 0;
    const controller = createEditorController({
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
      onSegmentCommitted: () => {
        committed += 1;
      },
    });
    return { controller, dirty: () => dirty, committed: () => committed, setSelected };
  });
  return { ...value, dispose };
};

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
