import { createEffect, createSignal, type Accessor } from "solid-js";
import { createMutation, useQuery, type QueryClient } from "@tanstack/solid-query";
import { readApiError, type ApiClient } from "../../api";
import type { components } from "../../generated/api";
import { cancellationIsCurrent } from "../queue/cancellation";
import { cancelJobLifecycle } from "../queue/queryLifecycle";
import { jobPollInterval } from "../queue/jobPolling";
import {
  acceptCandidates,
  type Candidate,
  type CandidateAcceptance,
  type DetectionKind,
  skippedCandidateSummary,
} from "./model";
import type { Segment } from "../preview/model";

type Media = components["schemas"]["Media"];
type Project = components["schemas"]["Project"];
type DetectionJob = components["schemas"]["DetectionJob"];
type DetectionCancellation = {
  jobId: string;
  request: number;
};

type DetectionReview = {
  jobId: string;
  projectId: string;
  mediaId: string;
  activeItemId: string | undefined;
  sourceFingerprint: string | undefined;
  baselineRevision: number;
  currentRevision: number;
  editorVersion: number;
  pendingLocalSave: boolean;
  invalidated: boolean;
};

type DetectionDependencies = {
  selected: Accessor<Media | undefined>;
  activeItemId: Accessor<string | undefined>;
  projectId: Accessor<string>;
  revision: Accessor<number>;
  editorVersion: Accessor<number>;
  saveConflict: Accessor<boolean>;
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
  let localCancellation: DetectionCancellation | undefined;
  const invalidatedTerminalJobs = new Set<string>();
  const reviewedCandidateIDs = new Set<string>();
  let detectionReview: DetectionReview | undefined;
  let failedCancellation: DetectionCancellation | undefined;
  let applyingDetectionEdit = false;
  const invalidateDetectionReview = () => {
    if (detectionReview) {
      detectionReview.invalidated = true;
      detectionReview.pendingLocalSave = false;
    }
  };
  const synchronizeDetectionReview = () => {
    const review = detectionReview;
    if (!review) return true;
    if (review.invalidated) return false;
    const selected = dependencies.selected();
    if (
      dependencies.projectId() !== review.projectId ||
      dependencies.activeItemId() !== review.activeItemId ||
      selected?.id !== review.mediaId ||
      selected?.etag !== review.sourceFingerprint ||
      dependencies.saveConflict() ||
      dependencies.editorVersion() !== review.editorVersion
    ) {
      invalidateDetectionReview();
      return false;
    }
    const revision = dependencies.revision();
    if (revision === review.currentRevision) return true;
    if (review.pendingLocalSave && revision === review.currentRevision + 1) {
      review.currentRevision = revision;
      review.pendingLocalSave = false;
      return true;
    }
    invalidateDetectionReview();
    return false;
  };
  const createDetectionReview = (job: DetectionJob) => {
    if (detectionReview?.jobId === job.id) return;
    const selected = dependencies.selected();
    const currentRevision = dependencies.revision();
    detectionReview = {
      jobId: job.id,
      projectId: dependencies.projectId(),
      mediaId: job.mediaId,
      activeItemId: dependencies.activeItemId(),
      sourceFingerprint: selected?.etag,
      baselineRevision: job.projectRevision,
      currentRevision,
      editorVersion: dependencies.editorVersion(),
      pendingLocalSave: false,
      invalidated:
        !selected ||
        selected.id !== job.mediaId ||
        currentRevision !== job.projectRevision ||
        dependencies.saveConflict(),
    };
  };
  const staleAcceptance = (candidates: Candidate[]): CandidateAcceptance => ({
    segments: dependencies.segments(),
    accepted: [],
    skipped: candidates.map((candidate) => ({ candidate, reason: "stale" })),
  });
  createEffect(() => {
    dependencies.revision();
    dependencies.editorVersion();
    dependencies.saveConflict();
    dependencies.projectId();
    dependencies.activeItemId();
    dependencies.selected();
    if (applyingDetectionEdit) return;
    synchronizeDetectionReview();
  });
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
      jobPollInterval(query.state.data ?? detectionJob(), 500),
  }));
  const setDetectionResult = (candidates: Candidate[]) => {
    const job = detectionJob();
    if (job?.state === "succeeded") createDetectionReview(job);
    setDetectionCandidates(
      candidates.filter((candidate) => !reviewedCandidateIDs.has(candidate.id)),
    );
    if (!reviewedCandidateIDs.size)
      setDetectionStatus(`${candidates.length} candidates found. Review each before accepting.`);
  };
  createEffect(() => {
    const error = detectionStatusQuery.error;
    const current = detectionJob();
    const cancellationFailure =
      failedCancellation &&
      failedCancellation.jobId === current?.id &&
      failedCancellation.request === detectionRequest;
    if (
      error &&
      current &&
      (current.state === "queued" || current.state === "running") &&
      !localCancellation &&
      !cancellationFailure
    ) {
      setDetectionStatus(
        error instanceof Error ? error.message : "Detection status could not be updated.",
      );
    }
  });
  createEffect(() => {
    const next = detectionStatusQuery.data;
    const cancellation = localCancellation;
    if (!next || next.id !== detectionJob()?.id) return;
    if (
      (next.state === "queued" || next.state === "running") &&
      cancellation?.jobId === next.id &&
      cancellation.request === detectionRequest
    )
      return;
    setDetectionJob(next);
    if (next.state === "succeeded") {
      setDetectionResult(next.candidates ?? []);
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
    localCancellation = undefined;
    failedCancellation = undefined;
    detectionReview = undefined;
    detectionRequest++;
    setDetectionJob();
    reviewedCandidateIDs.clear();
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
    detectionController?.abort();
    detectionController = undefined;
    detectionCancellationController?.abort();
    detectionCancellationController = undefined;
    localCancellation = undefined;
    failedCancellation = undefined;
    detectionReview = undefined;
    reviewedCandidateIDs.clear();
    setDetectionJob();
    setDetectionCandidates([]);
    setDetectionStatus("Saving project before detection…");
    const saved = await dependencies.saveProject();
    if (request !== detectionRequest) return;
    const selected = dependencies.selected();
    if (!saved || !selected) {
      setDetectionStatus(
        "Detection was not started. Save from the project header and resolve any reported errors.",
      );
      return;
    }
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
          sourceFingerprint: selected.etag,
          ...options,
        }),
        signal: controller.signal,
      });
      if (controller.signal.aborted || request !== detectionRequest) return;
      if (!response.ok) {
        const error = await readApiError(response);
        if (controller.signal.aborted || request !== detectionRequest) return;
        setDetectionStatus(
          error.code === "stale_project"
            ? "Detection is stale; save or reload the project."
            : error.code === "detection_busy"
              ? "Detection capacity is busy. Try again shortly."
              : error.code === "invalid_detection"
                ? "Detection settings were rejected. Check the sensitivity values."
                : "Detection could not be started.",
        );
        return;
      }
      const job = (await response.json()) as DetectionJob;
      if (controller.signal.aborted || request !== detectionRequest) return;
      setDetectionJob(job);
      if (job.state === "succeeded") {
        setDetectionResult(job.candidates ?? []);
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
    detectionController = undefined;
    detectionCancellationController?.abort();
    const controller = new AbortController();
    detectionCancellationController = controller;
    localCancellation = { jobId: job.id, request };
    failedCancellation = undefined;
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
      const currentJob = detectionJob();
      if (
        !currentJob ||
        currentJob.id !== job.id ||
        (currentJob.state !== "queued" && currentJob.state !== "running") ||
        !cancellationIsCurrent(controller, detectionCancellationController)
      )
        return;
      failedCancellation = undefined;
      setDetectionJob({ ...job, state: "cancelled" });
      setDetectionStatus("Detection cancelled.");
    } catch (error) {
      const currentJob = detectionJob();
      if (
        request === detectionRequest &&
        currentJob?.id === job.id &&
        !controller.signal.aborted &&
        (currentJob.state === "queued" || currentJob.state === "running")
      ) {
        localCancellation = undefined;
        failedCancellation = { jobId: job.id, request };
        setDetectionStatus(
          error instanceof Error ? error.message : "Detection could not be cancelled. Try again.",
        );
      }
    } finally {
      if (detectionCancellationController === controller)
        detectionCancellationController = undefined;
    }
  };
  const recordLocalDetectionEdit = () => {
    const review = detectionReview;
    if (!review || review.invalidated) return;
    review.pendingLocalSave = true;
    review.editorVersion = dependencies.editorVersion();
  };
  const applyAcceptedSegments = (segments: Segment[]) => {
    applyingDetectionEdit = true;
    try {
      dependencies.updateSegments(segments);
      dependencies.markDirty();
      recordLocalDetectionEdit();
    } finally {
      applyingDetectionEdit = false;
    }
  };
  const acceptanceFor = (candidates: Candidate[]): CandidateAcceptance => {
    if (detectionReview && !synchronizeDetectionReview()) return staleAcceptance(candidates);
    const selected = dependencies.selected();
    if (!selected) return { segments: dependencies.segments(), accepted: [], skipped: [] };
    return acceptCandidates(
      candidates,
      {
        id: dependencies.projectId(),
        mediaId: selected.id,
        revision: detectionReview?.baselineRevision ?? dependencies.revision(),
        segments: dependencies.segments(),
      },
      selected.durationMs,
    );
  };
  const acceptDetection = (candidate: Candidate): CandidateAcceptance => {
    const result = acceptanceFor([candidate]);
    if (!result.accepted.length) {
      setDetectionStatus(
        candidate.source === "scene"
          ? "Scene changes are points; preview or dismiss them instead of adding a segment."
          : "Candidate is stale, invalid, or overlaps an existing segment.",
      );
      return result;
    }
    applyAcceptedSegments(result.segments);
    reviewedCandidateIDs.add(candidate.id);
    setDetectionCandidates((items: Candidate[]) =>
      items.filter((item) => item.id !== candidate.id),
    );
    setDetectionStatus("Candidate accepted; save the project to persist it.");
    return result;
  };
  const rejectDetection = (candidate: Candidate) => {
    reviewedCandidateIDs.add(candidate.id);
    setDetectionCandidates((items: Candidate[]) =>
      items.filter((item) => item.id !== candidate.id),
    );
    setDetectionStatus("Candidate dismissed.");
    return true;
  };
  const bulkAcceptDetection = (): CandidateAcceptance => {
    const result = acceptanceFor(detectionCandidates());
    if (!result.accepted.length) {
      const skipped = skippedCandidateSummary(result.skipped);
      setDetectionStatus(
        skipped ? `No candidates accepted; skipped ${skipped}.` : "No candidates to accept.",
      );
      return result;
    }
    applyAcceptedSegments(result.segments);
    for (const candidate of result.accepted) reviewedCandidateIDs.add(candidate.id);
    const acceptedIDs = new Set(result.accepted.map((candidate) => candidate.id));
    setDetectionCandidates((items: Candidate[]) =>
      items.filter((item) => !acceptedIDs.has(item.id)),
    );
    const skipped = skippedCandidateSummary(result.skipped);
    setDetectionStatus(
      skipped
        ? `Accepted ${result.accepted.length} candidates; skipped ${skipped}. Save the project to persist them.`
        : `Accepted ${result.accepted.length} candidates; save the project to persist them.`,
    );
    return result;
  };

  return {
    detectionJob,
    setDetectionJob,
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    detectionLoading: () => Boolean(detectionJob()?.id) && detectionStatusQuery.isFetching,
    detectionQueryError: () => {
      const error = detectionStatusQuery.error;
      const job = detectionJob();
      if (!error || job?.state === "cancelled" || localCancellation?.jobId === job?.id) return "";
      return error instanceof Error ? error.message : "Detection status could not be updated.";
    },
    clearDetectionContext,
    startDetection,
    cancelDetection,
    acceptDetection,
    rejectDetection,
    bulkAcceptDetection,
  };
}
