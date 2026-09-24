import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createComponent, createRoot, createSignal, untrack } from "solid-js";
import { describe, expect, it } from "vitest";
import { editTimeline, createTimelineHistory, undoTimeline } from "../src/features/editor/timeline";
import {
  acceptCandidate,
  acceptCandidates,
  candidatePointMs,
  candidateSkipReason,
  skippedCandidateSummary,
  type Candidate,
  type CandidateAcceptance,
} from "../src/features/detection/model";
import type { ApiClient } from "../src/api";
import { createDetectionController } from "../src/features/detection/controller";
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
it("preserves a local detection cancellation over stale cached status", async () => {
  let releaseDelete!: (response: Response) => void;
  let markDeleteStarted!: () => void;
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve;
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
      return Promise.resolve(Response.json(queuedDetectionJob));
    },
    assetRequest: () => Promise.resolve(Response.json({})),
    interchangeRequest: () => Promise.resolve(Response.json({})),
  };

  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      try {
        const queryClient = new QueryClient({
          defaultOptions: { queries: { retry: false } },
        });
        let runCancellation!: () => Promise<void>;
        const [selected] = createSignal(detectionMedia);
        const [activeItemId] = createSignal("i_detection");
        const [projectId] = createSignal(queuedDetectionJob.projectId);
        const [revision] = createSignal(queuedDetectionJob.projectRevision);
        createComponent(QueryClientProvider, {
          client: queryClient,
          get children() {
            untrack(() => {
              const current = createDetectionController(api, queryClient, {
                selected,
                activeItemId,
                projectId,
                revision,
                editorVersion: () => 0,
                saveConflict: () => false,
                segments: () => [],
                saveProject: () => Promise.resolve(undefined),
                updateSegments: () => undefined,
                markDirty: () => undefined,
              });
              runCancellation = async () => {
                current.setDetectionJob(queuedDetectionJob);
                const cancellation = current.cancelDetection();
                await deleteStarted;
                queryClient.setQueryData(
                  ["job", "detection", queuedDetectionJob.id],
                  queuedDetectionJob,
                );
                releaseDelete(new Response(null, { status: 204 }));
                await cancellation;
                expect(current.detectionJob()?.state).toBe("cancelled");
                expect(current.detectionStatus()).toBe("Detection cancelled.");
              };
            });
            return null;
          },
        });
        queueMicrotask(() => {
          void runCancellation().then(
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
      } catch (error) {
        dispose();
        reject(error);
      }
    });
  });
});
it("accepts successive detection candidates across its own saved revisions but rejects external changes", async () => {
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
    interchangeRequest: () => Promise.resolve(Response.json({})),
  };
  await new Promise<void>((resolve, reject) => {
    createRoot((dispose) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const [revision, setRevision] = createSignal(1);
      const [editorVersion, setEditorVersion] = createSignal(0);
      const [segments, setSegments] = createSignal<components["schemas"]["Segment"][]>([]);
      let start!: (kind: "silence") => Promise<void>;
      let accept!: (candidate: Candidate) => CandidateAcceptance;
      createComponent(QueryClientProvider, {
        client: queryClient,
        get children() {
          untrack(() => {
            const current = createDetectionController(api, queryClient, {
              selected: () => detectionMedia,
              activeItemId: () => "i_detection",
              projectId: () => queuedDetectionJob.projectId,
              revision,
              editorVersion,
              saveConflict: () => false,
              segments,
              saveProject: () =>
                Promise.resolve({
                  id: queuedDetectionJob.projectId,
                  revision: 1,
                } as components["schemas"]["Project"]),
              updateSegments: setSegments,
              markDirty: () => setEditorVersion((value) => value + 1),
            });
            start = current.startDetection;
            accept = current.acceptDetection;
          });
          return null;
        },
      });
      queueMicrotask(() => {
        void start("silence").then(() => {
          try {
            expect(accept(candidates[0]).accepted).toHaveLength(1);
            setRevision(2);
            expect(accept(candidates[1]).accepted).toHaveLength(1);
            setRevision(3);
            expect(accept(candidates[2]).accepted).toHaveLength(1);
            setRevision(5);
            expect(accept(candidates[3]).accepted).toHaveLength(0);
            dispose();
            resolve();
          } catch (error) {
            dispose();
            reject(error);
          }
        }, reject);
      });
    });
  });
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
