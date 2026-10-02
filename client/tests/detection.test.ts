import type * as EffectApiTypes from "../src/generated/effect-api";
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
const detectionMedia: EffectApiTypes.Media = {
  id: "m_detection",
  name: "detection.mp4",
  durationMs: 1_000,
  sizeBytes: 1,
  container: "mp4",
  streams: {},
  etag: "v1",
};
const queuedDetectionJob: EffectApiTypes.DetectionJob = {
  id: "j_012345678901",
  type: "detection",
  state: "queued",
  mediaId: detectionMedia.id,
  projectId: "p_000000000001",
  projectRevision: 1,
  kind: "silence",
};
const jobEvent = (job: EffectApiTypes.DetectionJob, revision = 1) => {
  const snapshot = {
    ...job,
    revision,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  return new Response(`id: ${revision}\nevent: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`, {
    headers: { "Content-Type": "text/event-stream" },
  });
};
async function withDetection(
  api: ApiClient,
  exercise: (
    controller: DetectionController,
    state: {
      setRevision: (value: number) => void;
      editorVersion: () => number;
      setProjectId: (value: string) => void;
    },
  ) => Promise<void>,
  overrides: {
    selected?: () => EffectApiTypes.Media | undefined;
    activeItemId?: () => string | undefined;
    saveProject?: () => Promise<EffectApiTypes.Project | undefined>;
  } = {},
) {
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const [revision, setRevision] = createSignal(1);
      const [projectId, setProjectId] = createSignal(queuedDetectionJob.projectId);
      const [editorVersion, setEditorVersion] = createSignal(0);
      const [segments, setSegments] = createSignal<
        EffectApiTypes.Project["items"][number]["segments"][number][]
      >([]);
      let controller!: DetectionController;
      const configuration = {
        serverBaseUrl: "https://example.test",
        authentication: { type: "none" as const },
      };
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        return api.request(url.pathname.replace(/^\/api\/v2\//, "") + url.search, init);
      });
      createComponent(RegistryProvider, {
        get children() {
          untrack(() => {
            const registry = useContext(RegistryContext);
            controller = createDetectionController(
              createServerState({ ...api, mediaRequest: api.request }, registry, configuration),
              {
                selected: overrides.selected ?? (() => detectionMedia),
                activeItemId: overrides.activeItemId ?? (() => "i_detection"),
                projectId,
                revision,
                editorVersion,
                saveConflict: () => false,
                segments,
                saveProject:
                  overrides.saveProject ??
                  (() =>
                    Promise.resolve({
                      id: projectId(),
                      revision: revision(),
                    } as EffectApiTypes.Project)),
                updateSegments: (value) => {
                  setSegments(value);
                  setEditorVersion((version) => version + 1);
                },
              },
            );
          });
          return null;
        },
      });
      queueMicrotask(() => {
        void exercise(controller, { setRevision, editorVersion, setProjectId }).then(
          () => {
            dispose();
            vi.unstubAllGlobals();
            resolve();
          },
          (error: unknown) => {
            dispose();
            vi.unstubAllGlobals();
            reject(error);
          },
        );
      });
    });
  });
}

it("redelivers an uncertain detection submission with its original key and validated body", async () => {
  const submissions: Array<{ key: string | null; target: string; body: string }> = [];
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST") {
        submissions.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          target: path.split("/")[1]!,
          body: String(init.body),
        });
        return Promise.resolve(
          submissions.length === 1
            ? Response.json(
                { error: { code: "upstream_timeout", message: "Retry", requestId: "r1" } },
                { status: 503 },
              )
            : Response.json(queuedDetectionJob, { status: 202 }),
        );
      }
      if (path.endsWith("/events")) return Promise.resolve(jobEvent(queuedDetectionJob));
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await controller.startDetection("silence", { noiseDb: -35 });
    await controller.startDetection("silence", { noiseDb: -35 });
    expect(submissions).toHaveLength(2);
    expect(submissions[0].key).toBeTruthy();
    expect(submissions[0].key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(submissions[0].target).toBe(queuedDetectionJob.projectId);
    expect(JSON.parse(submissions[0].body)).toMatchObject({
      mediaId: detectionMedia.id,
      projectItemId: "i_detection",
      projectRevision: 1,
      kind: "silence",
      noiseDb: -35,
    });
  });
});

it("uses a fresh key for an uncertain identical command sent to another project", async () => {
  const secondProjectId = "p_000000000002";
  const submissions: Array<{ key: string | null; target: string; body: string }> = [];
  let acceptedJob: EffectApiTypes.DetectionJob | undefined;
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST") {
        const target = path.split("/")[1]!;
        submissions.push({
          key: new Headers(init.headers).get("Idempotency-Key"),
          target,
          body: String(init.body),
        });
        if (submissions.length === 1)
          return Promise.resolve(
            Response.json(
              { error: { code: "internal_error", message: "Retry", requestId: "r1" } },
              { status: 503 },
            ),
          );
        acceptedJob = { ...queuedDetectionJob, projectId: target };
        return Promise.resolve(Response.json(acceptedJob, { status: 202 }));
      }
      if (path.endsWith("/events") && acceptedJob) return Promise.resolve(jobEvent(acceptedJob));
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller, { setProjectId }) => {
    await controller.startDetection("silence", { noiseDb: -35 });
    setProjectId(secondProjectId);
    await controller.startDetection("silence", { noiseDb: -35 });
    expect(submissions).toHaveLength(2);
    expect(submissions.map(({ target }) => target)).toEqual([
      queuedDetectionJob.projectId,
      secondProjectId,
    ]);
    expect(submissions[0].body).toBe(submissions[1].body);
    expect(submissions[0].key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(submissions[1].key).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(submissions[1].key).not.toBe(submissions[0].key);
  });
});

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
      if (path.startsWith("projects/") && init?.method === "POST")
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      if (path === `jobs/${queuedDetectionJob.id}/events`) {
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
    await controller.startDetection("silence");
    await statusStarted;
    const cancellation = controller.cancelDetection();
    const cancellationProgress = await Promise.race([
      deleteStarted.then(() => "delete"),
      cancellation.then(() => "done"),
    ]);
    expect(cancellationProgress, controller.detectionStatus()).toBe("delete");
    releaseStatus(jobEvent(queuedDetectionJob));
    releaseDelete(new Response(null, { status: 204 }));
    await cancellation;
    expect(controller.detectionJob()).toBeUndefined();
    expect(controller.detectionStatus()).toBe("Detection cancellation requested.");
  });
});

it("clears optimistic cancellation when the delete fails", async () => {
  let eventRequests = 0;
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST")
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      if (path.endsWith("/events")) {
        eventRequests++;
        return Promise.resolve(
          eventRequests === 1 ? jobEvent(queuedDetectionJob) : new Response(null, { status: 503 }),
        );
      }
      if (path === `jobs/${queuedDetectionJob.id}` && init?.method === "DELETE")
        return Promise.resolve(
          Response.json(
            { error: { code: "unavailable", message: "Delete unavailable", requestId: "r1" } },
            { status: 503 },
          ),
        );
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await controller.startDetection("silence");
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("queued"));
    await controller.cancelDetection();
    expect(controller.detectionJob()?.state).toBe("queued");
    expect(controller.detectionStatus()).not.toBe("Detection cancellation requested.");
  });
});

it("keeps a terminal SSE result that arrives before the cancellation acknowledgement", async () => {
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
  const resultCandidate = {
    id: "c_terminal",
    mediaId: detectionMedia.id,
    projectId: queuedDetectionJob.projectId,
    projectRevision: 1,
    startMs: 25,
    endMs: 35,
    source: "silence" as const,
  };
  const api: ApiClient = {
    url: (path) => path,
    request: (path, init) => {
      if (path === `jobs/${queuedDetectionJob.id}` && init?.method === "DELETE")
        return new Promise<Response>((resolve) => {
          releaseDelete = resolve;
          markDeleteStarted();
        });
      if (path.startsWith("projects/") && init?.method === "POST")
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      if (path === `jobs/${queuedDetectionJob.id}/events`)
        return new Promise<Response>((resolve) => {
          releaseStatus = resolve;
          markStatusStarted();
        });
      return Promise.resolve(Response.json({}));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await controller.startDetection("silence");
    await statusStarted;
    const cancellation = controller.cancelDetection();
    await deleteStarted;
    releaseStatus(
      jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates: [resultCandidate] }),
    );
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"));
    releaseDelete(new Response(null, { status: 204 }));
    await cancellation;
    expect(controller.detectionJob()?.state).toBe("succeeded");
    expect(controller.detectionCandidates()).toEqual([resultCandidate]);
    expect(controller.detectionStatus()).toContain("candidates found");
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
    request: (path, init) =>
      path.endsWith("/detections") && init?.method === "POST"
        ? Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }))
        : Promise.resolve(jobEvent(completed, 2)),
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller, { setRevision, editorVersion }) => {
    await controller.startDetection("silence");
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"));
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
  let completeSave!: (project: EffectApiTypes.Project) => void;
  const saveProject = () =>
    new Promise<EffectApiTypes.Project>((resolve) => {
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
      } as EffectApiTypes.Project);
      await start;
      expect(submitted).toBe(false);
      expect(controller.detectionJob()).toBeUndefined();
      expect(controller.detectionStatus()).toBe("Detection is stale; save or reload the project.");
    },
    { selected, saveProject },
  );
});

it("reconnects after a transient status failure and offers completed candidates for review", async () => {
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
    request: (path, init) => {
      if (path.endsWith("/detections") && init?.method === "POST")
        return Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }));
      requests++;
      return Promise.resolve(
        requests === 1
          ? Response.json(
              { error: { code: "unavailable", message: "Status unavailable", requestId: "r1" } },
              { status: 503 },
            )
          : jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates: [candidate] }, 2),
      );
    },
    assetRequest: () => Promise.resolve(Response.json({})),
  };
  await withDetection(api, async (controller) => {
    await controller.startDetection("silence");
    await vi.waitFor(() => expect(controller.detectionJob()?.state).toBe("succeeded"), {
      timeout: 2_000,
    });
    expect(requests).toBe(2);
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
        ? Promise.resolve(Response.json(queuedDetectionJob, { status: 202 }))
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
        jobEvent({ ...queuedDetectionJob, state: "succeeded", candidates: [candidate] }, 2),
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
