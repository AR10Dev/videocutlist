import { describe, expect, it } from "vitest";
import {
  canRedoTimeline,
  canUndoTimeline,
  createTimelineHistory,
  editTimeline,
  redoTimeline,
  resetTimelineHistory,
  undoTimeline,
  type TimelineSnapshot,
} from "../src/timeline";

const initial: TimelineSnapshot = {
  playheadMs: 0,
  inMs: 0,
  outMs: 1000,
  segments: [{ startMs: 0, endMs: 1000, label: "intro" }],
  zoom: 1,
};

describe("timeline history", () => {
  it("restores the complete timeline snapshot and redoes it", () => {
    const changed = editTimeline(
      createTimelineHistory(initial),
      { playheadMs: 400, inMs: 200, outMs: 800, segments: [], zoom: 2 },
    );
    expect(canUndoTimeline(changed)).toBe(true);
    const undone = undoTimeline(changed);
    expect(undone.present).toEqual(initial);
    expect(canRedoTimeline(undone)).toBe(true);
    expect(redoTimeline(undone).present).toEqual(changed.present);
  });

  it("clears redo after a new edit", () => {
    const history = editTimeline(createTimelineHistory(initial), { zoom: 2 });
    const undone = undoTimeline(history);
    const edited = editTimeline(undone, { playheadMs: 10 });
    expect(canRedoTimeline(edited)).toBe(false);
    expect(edited.present.playheadMs).toBe(10);
  });

  it("does not create history for a no-op and reset starts clean", () => {
    const history = createTimelineHistory(initial);
    expect(editTimeline(history, initial)).toBe(history);
    const reset = resetTimelineHistory({ ...initial, segments: [], zoom: 3 });
    expect(canUndoTimeline(reset)).toBe(false);
    expect(canRedoTimeline(reset)).toBe(false);
  });
});
