import { describe, expect, it } from "vitest";
import { isActiveState, isTerminalState } from "../src/features/queue/jobState";
import { isBatchActive } from "../src/features/export/queueResponse";
import * as Schema from "effect/Schema";
import { Batch } from "../src/generated/effect-api";

describe("job state predicates", () => {
  it.each([
    ["queued", true, false],
    ["running", true, false],
    ["succeeded", false, true],
    ["failed", false, true],
    ["cancelled", false, true],
    [undefined, false, false],
    ["unknown", false, false],
  ])("classifies %s", (state, active, terminal) => {
    expect(isActiveState(state)).toBe(active);
    expect(isTerminalState(state)).toBe(terminal);
  });

  it("keeps a terminal batch active while a child is active", () => {
    const batch = Schema.decodeUnknownSync(Batch)({
      batchId: "b_test",
      state: "failed",
      progress: 0,
      jobs: [
        {
          id: "j_test",
          type: "export",
          state: "running",
          revision: 1,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    expect(isBatchActive(batch)).toBe(true);
    expect(isBatchActive({ ...batch, jobs: [] })).toBe(false);
    expect(isBatchActive(undefined)).toBe(false);
  });
});
