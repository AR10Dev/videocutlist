import { RegistryProvider, RegistryContext } from "@effect/atom-solid";
import { createComponent, createRoot, createSignal, untrack, useContext } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { editTimeline, createTimelineHistory, undoTimeline } from "../src/features/editor/timeline";
import {
  acceptCandidate,
  acceptCandidates,
  candidatePointMs,
  candidateSkipReason,
  skippedCandidateSummary,
  type Candidate,
} from "../src/features/detection/model";
import type { ApiClient } from "../src/api";
import {
  createDetectionController,
  type DetectionController,
} from "../src/features/detection/controller";
import { createServerState } from "../src/features/app/server";
import type { components } from "../src/generated/api";

const candidate = {
  id: "c_1",
  mediaId: "m_1",
  projectId: "p_1",
  projectRevision: 2,
  startMs: 10,
  endMs: 20,
  source: "silence" as const,
};
const point = {
  id: "c_point",
  mediaId: "m_1",
  projectId: "p_1",
  projectRevision: 2,
  pointMs: 50,
  source: "scene" as const,
};
const project = { id: "p_1", mediaId: "m_1", revision: 2, segments: [] };
const detectionMedia: components["schemas"]["Media"] = {
  id: "m_detection",
  name: "detection.mp4",
  durationMs: 1_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
};
const queuedDetectionJob: components["schemas"]["DetectionJob"] = {
  id: "j_detection",
  type: "detection",
  state: "queued",
  mediaId: detectionMedia.id,
  projectId: "p_detection",
  projectRevision: 1,
  kind: "silence",
};
async function withDetection(
  api: ApiClient,
  exercise: (
    controller: DetectionController,
    state: { setRevision: (value: number) => void; editorVersion: () => number },
  ) => Promise<void>,
  overrides: {
    selected?: () => components["schemas"]["Media"] | undefined;
    activeItemId?: () => string | undefined;
    saveProject?: () => Promise<components["schemas"]["Project"] | undefined>;
  } = {},
) {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [revision, setRevision] = createSignal(1);
      const [editorVersion, setEditorVersion] = createSignal(0);
      const [segments, setSegments] = createSignal<components["schemas"]["Segment"][]>([]);
      let controller!: DetectionController;
      createComponent(RegistryProvider, {
        get children() {
          untrack(() => {
            const registry = useContext(RegistryContext);
            controller = createDetectionController(createServerState(api, registry), {
              selected: overrides.selected ?? (() => detectionMedia),
              activeItemId: overrides.activeItemId ?? (() => "i_detection"),
              projectId: () => queuedDetectionJob.projectId,
              revision,
              editorVersion,
              saveConflict: () => false,
              segments,
              saveProject:
                overrides.saveProject ??
                (() =>
                  Promise.resolve({
                    id: queuedDetectionJob.projectId,
                    revision: revision(),
                  } as components["schemas"]["Project"])),
              updateSegments: (value) => {
                setSegments(value);
                setEditorVersion((version) => version + 1);
              },
            });
          });
          return null;
        },
      });
      queueMicrotask(() => {
        void exercise(controller, { setRevision, editorVersion }).then(
          () => {
            dispose();
            resolve();
          },
          (error: unknown) => {
            dispose();
            reject(error);
          },
        );
      });
    });
  });
}

it("preserves a local detection cancellation over stale status responses", async () => {
  let releaseDelete!: (response: Response) => void;
  let releaseStatus!: (response: Response) => void;
  let markDeleteStarted!: () => void;
  let markStatusStarted!: () => void;
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve;
  });
  const statusStarted = new Promise<void>((resolve) => {
    markStatusStarted = resolve;
  });
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path === `jobs/${queuedDetectionJob.id}` && init?.method === "DELETE") {
        return new Promise<Response>((resolve) => {
          releaseDelete = resolve;
          markDeleteStarted();
        });
      }
      if (path === `jobs/${queuedDetectionJob.id}`) {
        return new Promise<Response>((resolve) => {
          releaseStatus = resolve;
          markStatusStarted();
        });
      }
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    controller.setDetectionJob(queuedDetectionJob);
    await statusStarted;
    const cancellation = controller.cancelDetection();
    await deleteStarted;
    releaseStatus(Response.json(queuedDetectionJob));
    releaseDelete(new Response(null, { status: 204 }));
    await cancellation;
    expect(controller.detectionJob()?.state).toBe("cancelled");
    expect(controller.detectionStatus()).toBe("Detection cancelled.");
  });
});

it("accepts successive candidates across its own saved revisions but rejects external changes", async () => {
  const candidates = [10, 30, 50, 70].map((startMs, index) => ({
    id: `c_review_${index}`,
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs,
    endMs: startMs + 5,
    source: "silence" as const,
  }));
  const completed = { ...queuedDetectionJob, state: "succeeded" as const, candidates };
  const api: ApiClient = {
    url: (path) => path,
    request: () => Promise.resolve(Response.json(completed)),
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller, { setRevision, editorVersion }) => {
    await controller.startDetection("silence");
    expect(controller.acceptDetection(candidates[0]).accepted).toHaveLength(1);
    expect(editorVersion()).toBe(1);
    setRevision(2);
    expect(controller.acceptDetection(candidates[1]).accepted).toHaveLength(1);
    expect(editorVersion()).toBe(2);
    setRevision(3);
    expect(controller.acceptDetection(candidates[2]).accepted).toHaveLength(1);
    setRevision(5);
    expect(controller.acceptDetection(candidates[3]).accepted).toHaveLength(0);
  });
});

it("does not submit detection when the source changes during the required save", async () => {
  let completeSave!: (project: components["schemas"]["Project"]) => void;
  const saveProject = () =>
    new Promise<components["schemas"]["Project"]>((resolve) => {
      completeSave = resolve;
    });
  const [selected, setSelected] = createSignal(detectionMedia);
  let submitted = false;
  const api: ApiClient = {
    url: (path) => path,
    request: () => {
      submitted = true;
      return Promise.resolve(Response.json(queuedDetectionJob));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(
    api,
    async (controller) => {
      const start = controller.startDetection("silence");
      expect(controller.detectionStatus()).toBe("Saving project before detection…");
      expect(submitted).toBe(false);
      setSelected({ ...detectionMedia, etag: "updated" });
      completeSave({
        id: queuedDetectionJob.projectId,
        revision: 1,
      } as components["schemas"]["Project"]);
      await start;
      expect(submitted).toBe(false);
      expect(controller.detectionJob()).toBeUndefined();
      expect(controller.detectionStatus()).toBe("Detection is stale; save or reload the project.");
    },
    { selected, saveProject },
  );
});

it("recovers a failed status update and offers the completed candidates for review", async () => {
  const candidate = {
    id: "c_recovered",
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs: 100,
    endMs: 125,
    source: "silence" as const,
  };
  let requests = 0;
  const api: ApiClient = {
    url: (path) => path,
    request: () => {
      requests++;
      return Promise.resolve(
        requests === 1
          ? Response.json(
              { error: { code: "unavailable", message: "Status unavailable", requestId: "r1" } },
              { status: 503 },
            )
          : Response.json({ ...queuedDetectionJob, state: "succeeded", candidates: [candidate] }),
      );
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    controller.setDetectionJob(queuedDetectionJob);
    await vi.waitFor(() => expect(controller.detectionQueryError()).toBe("Status unavailable"));
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"), {
      timeout: 2_000,
    });
    expect(controller.detectionCandidates()).toEqual([candidate]);
    expect(controller.detectionQueryError()).toBe("");
    expect(controller.acceptDetection(candidate).accepted).toHaveLength(1);
  });
});

it("rejects completed candidates after changing the active project item", async () => {
  const candidate = {
    id: "c_other_item",
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs: 180,
    endMs: 190,
    source: "silence" as const,
  };
  let completeStatus!: (response: Response) => void;
  const [activeItemId, setActiveItemId] = createSignal("i_detection");
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) =>
      path.startsWith("projects/") && init?.method === "POST"
        ? Promise.resolve(Response.json(queuedDetectionJob))
        : new Promise<Response>((resolve) => {
            completeStatus = resolve;
          }),
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(
    api,
    async (controller) => {
      await controller.startDetection("silence");
      await vi.waitFor(() => expect(completeStatus).toBeTypeOf("function"));
      setActiveItemId("i_other");
      completeStatus(
        Response.json({ ...queuedDetectionJob, state: "succeeded", candidates: [candidate] }),
      );
      await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"));
      expect(controller.acceptDetection(candidate).skipped[0]?.reason).toBe("stale");
    },
    { activeItemId },
  );
});

describe("candidate acceptance", () => {
  it("adds only a current, non-overlapping range candidate", () =>
    expect(acceptCandidate(candidate, project, 100)?.segments).toEqual([
      { startMs: 10, endMs: 20, label: "silence", included: true },
    ]));

  it("reports stale, invalid, overlapping, and point candidates", () => {
    const result = acceptCandidates(
      [
        candidate,
        { ...candidate, id: "c_overlap", startMs: 15, endMs: 25 },
        { ...candidate, id: "c_stale", projectRevision: 1 },
        { ...candidate, id: "c_invalid", startMs: 90, endMs: 110 },
        point,
      ],
      project,
      100,
    );
    expect(result.accepted.map((item) => item.id)).toEqual(["c_1"]);
    expect(result.skipped.map((item) => [item.candidate.id, item.reason])).toEqual([
      ["c_overlap", "overlap"],
      ["c_stale", "stale"],
      ["c_invalid", "invalid"],
      ["c_point", "point"],
    ]);
    expect(skippedCandidateSummary(result.skipped)).toBe(
      "1 stale, 1 invalid, 1 overlapping, 1 scene points",
    );
    expect(candidateSkipReason({ ...candidate, endMs: 101 }, project, 100)).toBe("invalid");
  });

  it("keeps scene points review-only and supports legacy one-millisecond results", () => {
    expect(acceptCandidate(point, project, 100)).toBeNull();
    const legacy = {
      ...point,
      pointMs: undefined,
      startMs: 50,
      endMs: 51,
    } as unknown as Candidate;
    expect(candidatePointMs(legacy)).toBe(50);
    expect(candidateSkipReason(legacy, project, 100)).toBe("point");
    expect(candidateSkipReason({ ...point, pointMs: -1 }, project, 100)).toBe("invalid");
    expect(candidateSkipReason({ ...point, pointMs: 101 }, project, 100)).toBe("invalid");
  });

  it("publishes a bulk result as one undoable timeline edit", () => {
    const result = acceptCandidates(
      [candidate, { ...candidate, id: "c_2", startMs: 30, endMs: 40 }],
      project,
      100,
    );
    const history = editTimeline(
      createTimelineHistory({ playheadMs: 0, segments: project.segments, zoom: 1 }),
      { segments: result.segments },
    );
    expect(history.past).toHaveLength(1);
    expect(undoTimeline(history).present.segments).toEqual([]);
  });

  it("rejects stale and overlapping candidates without mutation", () => {
    expect(acceptCandidate({ ...candidate, projectRevision: 1 }, project, 100)).toBeNull();
    expect(
      acceptCandidate(
        { ...candidate, startMs: 15 },
        { ...project, segments: [{ startMs: 12, endMs: 18, included: true }] },
        100,
      ),
    ).toBeNull();
  });
});
