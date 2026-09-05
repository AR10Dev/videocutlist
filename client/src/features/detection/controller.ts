import { createEffect, createSignal, type Accessor } from "solid-js";
import { createMutation, useQuery, type QueryClient } from "@tanstack/solid-query";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import { cancellationIsCurrent } from "../queue/cancellation";
import { cancelJobLifecycle } from "../queue/queryLifecycle";
import { jobPollInterval } from "../queue/jobPolling";
import { acceptCandidate, type Candidate, type DetectionKind } from "./model";
import type { Segment } from "../preview/model";

type Media = components["schemas"]["Media"];
type Project = components["schemas"]["Project"];
type DetectionJob = components["schemas"]["DetectionJob"];

type DetectionDependencies = {
  selected: Accessor<Media | undefined>;
  activeItemId: Accessor<string | undefined>;
  projectId: Accessor<string>;
  revision: Accessor<number>;
  segments: Accessor<Segment[]>;
  saveProject: () => Promise<Project | undefined>;
  updateSegments: (segments: Segment[]) => void;
  markDirty: () => void;
};

export function createDetectionController(
  api: ApiClient,
  queryClient: QueryClient,
  dependencies: DetectionDependencies,
) {
  const [detectionJob, setDetectionJob] = createSignal<DetectionJob>();
  const [detectionStatus, setDetectionStatus] = createSignal("");
  const [detectionCandidates, setDetectionCandidates] = createSignal<Candidate[]>([]);
  let detectionRequest = 0;
  let detectionController: AbortController | undefined;
  let detectionCancellationController: AbortController | undefined;
  const invalidatedTerminalJobs = new Set<string>();
  const cancelJobMutation = createMutation(() => ({
    mutationFn: ({ id, signal }: { id: string; signal: AbortSignal }) =>
      api.request(`jobs/${encodeURIComponent(id)}`, { method: "DELETE", signal }),
  }));
  const detectionStatusQuery = useQuery(() => ({
    queryKey: ["job", "detection", detectionJob()?.id ?? null],
    enabled: Boolean(detectionJob()?.id),
    queryFn: async ({ signal }) => {
      const id = detectionJob()?.id;
      if (!id) throw new Error("Detection job ID is missing.");
      const response = await api.request(`jobs/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Detection status could not be updated.");
      return (await response.json()) as DetectionJob;
    },
    refetchInterval: (query: { state: { data?: DetectionJob } }) =>
      jobPollInterval(query.state.data, 500),
  }));
  createEffect(() => {
    const next = detectionStatusQuery.data;
    if (!next || next.id !== detectionJob()?.id) return;
    setDetectionJob(next);
    if (next.state === "succeeded") {
      setDetectionCandidates(next.candidates ?? []);
      setDetectionStatus(
        `${next.candidates?.length ?? 0} candidates found. Review each before accepting.`,
      );
    } else if (next.state === "queued" || next.state === "running") {
      setDetectionStatus(next.state === "queued" ? "Detection queued." : "Detection running.");
    } else {
      setDetectionStatus(
        next.state === "cancelled"
          ? "Detection cancelled."
          : `Detection failed${next.errorCode ? `: ${next.errorCode}.` : "."}`,
      );
    }
    if (
      ["succeeded", "failed", "cancelled"].includes(next.state) &&
      !invalidatedTerminalJobs.has(next.id)
    ) {
      invalidatedTerminalJobs.add(next.id);
      void queryClient.invalidateQueries({ queryKey: ["job", "detection", next.id] });
      void queryClient.invalidateQueries({ queryKey: ["project", dependencies.projectId()] });
      void queryClient.invalidateQueries({ queryKey: ["media"] });
    }
  });

  const clearDetectionContext = () => {
    detectionController?.abort();
    detectionController = undefined;
    detectionCancellationController?.abort();
    detectionCancellationController = undefined;
    detectionRequest++;
    setDetectionJob();
    setDetectionCandidates([]);
    setDetectionStatus("");
  };
  const startDetection = async (
    kind: DetectionKind,
    options: Pick<
      components["schemas"]["DetectionInput"],
      "noiseDb" | "minDurationMs" | "sceneThreshold"
    > = {},
  ) => {
    const request = ++detectionRequest;
    setDetectionStatus("Saving project before detection…");
    const saved = await dependencies.saveProject();
    if (request !== detectionRequest) return;
    const selected = dependencies.selected();
    if (!saved || !selected) {
      setDetectionStatus(
        "Detection was not started. Save the project in Project and resolve any reported errors.",
      );
      return;
    }
    detectionController?.abort();
    const controller = new AbortController();
    detectionController = controller;
    setDetectionCandidates([]);
    setDetectionStatus(`Starting ${kind} detection…`);
    try {
      const response = await api.request(`projects/${encodeURIComponent(saved.id)}/detections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaId: selected.id,
          projectItemId: dependencies.activeItemId(),
          projectRevision: saved.revision,
          kind,
          ...options,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted || request !== detectionRequest) return;
      if (!response.ok) {
        setDetectionStatus(
          response.status === 409
            ? "Detection is stale; save or reload the project."
            : "Detection could not be started.",
        );
        return;
      }
      const job = (await response.json()) as DetectionJob;
      if (controller.signal.aborted || request !== detectionRequest) return;
      setDetectionJob(job);
      if (job.state === "succeeded") {
        setDetectionCandidates(job.candidates ?? []);
        setDetectionStatus(
          `${job.candidates?.length ?? 0} candidates found. Review each before accepting.`,
        );
      } else if (job.state === "cancelled") setDetectionStatus("Detection cancelled.");
      else if (job.state === "queued" || job.state === "running")
        setDetectionStatus(job.state === "queued" ? "Detection queued." : "Detection running.");
      else setDetectionStatus(`Detection failed${job.errorCode ? `: ${job.errorCode}.` : "."}`);
    } catch (error) {
      if (controller.signal.aborted || request !== detectionRequest) return;
      setDetectionStatus(
        error instanceof Error ? error.message : "Detection could not be started.",
      );
    }
  };
  const cancelDetection = async () => {
    const job = detectionJob();
    if (!job || (job.state !== "queued" && job.state !== "running")) return;
    const request = ++detectionRequest;
    detectionController?.abort();
    detectionCancellationController?.abort();
    const controller = new AbortController();
    detectionCancellationController = controller;
    try {
      await cancelJobLifecycle({
        jobId: job.id,
        signal: controller.signal,
        cancel: (id, signal) => cancelJobMutation.mutateAsync({ id, signal }),
        cancelQueries: (options) => queryClient.cancelQueries(options),
        invalidateQueries: (options) =>
          queryClient.invalidateQueries({ ...options, refetchType: "none" }),
        jobQueryKey: ["job", "detection", job.id],
        projectQueryKey: ["project", dependencies.projectId()],
      });
      if (
        request !== detectionRequest ||
        !cancellationIsCurrent(controller, detectionCancellationController)
      )
        return;
      setDetectionJob({ ...job, state: "cancelled" });
      setDetectionStatus("Detection cancelled.");
    } catch (error) {
      if (request === detectionRequest && !controller.signal.aborted)
        setDetectionStatus(
          error instanceof Error ? error.message : "Detection could not be cancelled. Try again.",
        );
    } finally {
      if (detectionCancellationController === controller)
        detectionCancellationController = undefined;
    }
  };
  const acceptDetection = (candidate: Candidate) => {
    const selected = dependencies.selected();
    if (!selected) return;
    const next = acceptCandidate(
      candidate,
      {
        id: dependencies.projectId(),
        mediaId: selected.id,
        revision: dependencies.revision(),
        segments: dependencies.segments(),
      },
      selected.durationMs,
    );
    if (!next) {
      setDetectionStatus("Candidate is stale, invalid, or overlaps an existing segment.");
      return;
    }
    dependencies.updateSegments(next.segments);
    dependencies.markDirty();
    setDetectionCandidates((items) => items.filter((item) => item.id !== candidate.id));
    setDetectionStatus("Candidate accepted; save the project to persist it.");
  };

  return {
    detectionJob,
    setDetectionJob,
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    clearDetectionContext,
    startDetection,
    cancelDetection,
    acceptDetection,
  };
}
