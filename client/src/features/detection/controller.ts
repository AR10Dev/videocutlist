import { createEffect, createSignal, type Accessor, type Setter } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { ApiFailure, apiJson, apiRequest, runEffect } from "../../api";
import { pollAtom, readServerAtom, type ServerState } from "../app/server";
import type { components } from "../../generated/api";
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

type SubmittedDetection = {
  jobId: string;
  projectId: string;
  mediaId: string;
  activeItemId: string | undefined;
  sourceFingerprint: string | undefined;
  editorVersion: number;
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
};

export interface DetectionController {
  detectionJob: Accessor<DetectionJob | undefined>;
  setDetectionJob: Setter<DetectionJob | undefined>;
  detectionStatus: Accessor<string>;
  setDetectionStatus: Setter<string>;
  detectionCandidates: Accessor<Candidate[]>;
  setDetectionCandidates: Setter<Candidate[]>;
  detectionLoading: Accessor<boolean>;
  detectionQueryError: Accessor<string>;
  clearDetectionContext: () => void;
  startDetection: (
    kind: DetectionKind,
    options?: Pick<
      components["schemas"]["DetectionInput"],
      "noiseDb" | "minDurationMs" | "sceneThreshold"
    >,
  ) => Promise<void>;
  cancelDetection: () => Promise<void>;
  acceptDetection: (candidate: Candidate) => CandidateAcceptance;
  rejectDetection: (candidate: Candidate) => boolean;
  bulkAcceptDetection: () => CandidateAcceptance;
}

export function createDetectionController(
  server: ServerState,
  dependencies: DetectionDependencies,
): DetectionController {
  const { api, registry, runtime } = server;
  const [detectionJob, setDetectionJob] = createSignal<DetectionJob>();
  const [detectionStatus, setDetectionStatus] = createSignal("");
  const [detectionCandidates, setDetectionCandidates] = createSignal<Candidate[]>([]);
  let operation = 0;
  const [localCancellation, setLocalCancellation] = createSignal<string>();
  const reviewedCandidateIDs = new Set<string>();
  let detectionReview: DetectionReview | undefined;
  let submittedDetection: SubmittedDetection | undefined;
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
    const submitted = submittedDetection?.jobId === job.id ? submittedDetection : undefined;
    detectionReview = {
      jobId: job.id,
      projectId: submitted?.projectId ?? dependencies.projectId(),
      mediaId: job.mediaId,
      activeItemId: submitted ? submitted.activeItemId : dependencies.activeItemId(),
      sourceFingerprint: submitted ? submitted.sourceFingerprint : selected?.etag,
      baselineRevision: job.projectRevision,
      currentRevision,
      editorVersion: submitted?.editorVersion ?? dependencies.editorVersion(),
      pendingLocalSave: false,
      invalidated:
        !selected ||
        selected.id !== job.mediaId ||
        currentRevision !== job.projectRevision ||
        dependencies.saveConflict() ||
        (submitted !== undefined &&
          (dependencies.projectId() !== submitted.projectId ||
            job.projectId !== submitted.projectId ||
            job.mediaId !== submitted.mediaId ||
            dependencies.activeItemId() !== submitted.activeItemId ||
            selected.etag !== submitted.sourceFingerprint ||
            dependencies.editorVersion() !== submitted.editorVersion)),
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
  const submit = runtime.fn(
    (input: {
      projectId: string;
      mediaId: string;
      projectItemId: string | undefined;
      projectRevision: number;
      kind: DetectionKind;
      sourceFingerprint: string | undefined;
      options: Pick<
        components["schemas"]["DetectionInput"],
        "noiseDb" | "minDurationMs" | "sceneThreshold"
      >;
    }) =>
      apiJson<DetectionJob>(api, `projects/${encodeURIComponent(input.projectId)}/detections`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mediaId: input.mediaId,
          projectItemId: input.projectItemId,
          projectRevision: input.projectRevision,
          kind: input.kind,
          sourceFingerprint: input.sourceFingerprint,
          ...input.options,
        }),
      }),
  );
  const cancel = runtime.fn((id: string) =>
    Effect.flatMap(
      apiRequest(api, `jobs/${encodeURIComponent(id)}`, { method: "DELETE" }),
      (response) =>
        response.ok
          ? Effect.succeed(undefined)
          : Effect.fail(new Error("Job could not be cancelled. Try again.")),
    ),
  );
  const statuses = Atom.family((id: string) =>
    pollAtom(
      runtime,
      apiJson<DetectionJob>(api, `jobs/${encodeURIComponent(id)}`),
      (job) => job.state === "queued" || job.state === "running",
      500,
    ),
  );
  const emptyStatus = Atom.make(AsyncResult.initial<DetectionJob, Error>());
  const status = useAtomValue(() => {
    const job = detectionJob();
    return job &&
      (job.state === "queued" || job.state === "running") &&
      localCancellation() !== job.id
      ? statuses(job.id)
      : emptyStatus;
  });
  let failedCancellation: string | undefined;
  const setDetectionResult = (candidates: Candidate[]) => {
    const job = detectionJob();
    if (job?.state === "succeeded") createDetectionReview(job);
    setDetectionCandidates(
      candidates.filter((candidate) => !reviewedCandidateIDs.has(candidate.id)),
    );
    if (!reviewedCandidateIDs.size)
      setDetectionStatus(`${candidates.length} candidates found. Review each before accepting.`);
  };
  const receiveDetectionJob = (next: DetectionJob) => {
    const current = detectionJob();
    if (next.id !== current?.id || localCancellation() === next.id) return;
    if (current.state === "cancelled") return;
    if (current.state === next.state && current === next) return;
    setDetectionJob(next);
    if (next.state === "succeeded") setDetectionResult(next.candidates ?? []);
    else if (next.state === "queued" || next.state === "running") {
      if (failedCancellation !== next.id) {
        setDetectionStatus(next.state === "queued" ? "Detection queued." : "Detection running.");
      }
    } else {
      setDetectionStatus(
        next.state === "cancelled"
          ? "Detection cancelled."
          : `Detection failed${next.errorCode ? `: ${next.errorCode}.` : "."}`,
      );
    }
    if (
      (next.state === "succeeded" || next.state === "failed" || next.state === "cancelled") &&
      (current.state === "queued" || current.state === "running")
    ) {
      server.refreshMedia();
    }
  };
  createEffect(() => {
    const result = status();
    const job = detectionJob();
    if (!job || localCancellation() === job.id) return;
    const error = Option.getOrUndefined(AsyncResult.error(result));
    if (
      error &&
      (job.state === "queued" || job.state === "running") &&
      failedCancellation !== job.id
    ) {
      setDetectionStatus(error.message);
    }
    const next = AsyncResult.isSuccess(result) && !result.waiting ? result.value : undefined;
    if (next) receiveDetectionJob(next);
  });

  const clearDetectionContext = () => {
    operation++;
    registry.set(submit, Atom.Interrupt);
    registry.set(cancel, Atom.Interrupt);
    setLocalCancellation();
    failedCancellation = undefined;
    detectionReview = undefined;
    submittedDetection = undefined;
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
    clearDetectionContext();
    const currentOperation = operation;
    const selectedBeforeSave = dependencies.selected();
    const projectBeforeSave = dependencies.projectId();
    const itemBeforeSave = dependencies.activeItemId();
    const editorBeforeSave = dependencies.editorVersion();
    setDetectionStatus("Saving project before detection…");
    try {
      const saved = await dependencies.saveProject();
      if (currentOperation !== operation) return;
      const selected = dependencies.selected();
      if (!saved || !selected) {
        setDetectionStatus(
          "Detection was not started. Save from the project header and resolve any reported errors.",
        );
        return;
      }
      if (
        saved.id !== projectBeforeSave ||
        dependencies.projectId() !== projectBeforeSave ||
        selected.id !== selectedBeforeSave?.id ||
        selected.etag !== selectedBeforeSave.etag ||
        dependencies.activeItemId() !== itemBeforeSave ||
        dependencies.editorVersion() !== editorBeforeSave
      ) {
        setDetectionStatus("Detection is stale; save or reload the project.");
        return;
      }
      setDetectionStatus(`Starting ${kind} detection…`);
      const input = {
        projectId: saved.id,
        mediaId: selected.id,
        projectItemId: itemBeforeSave,
        projectRevision: saved.revision,
        kind,
        sourceFingerprint: selected.etag,
        options,
      };
      registry.set(submit, input);
      const job = await runEffect(readServerAtom(server, submit));
      if (currentOperation !== operation) return;
      if (
        dependencies.projectId() !== saved.id ||
        dependencies.selected()?.id !== selected.id ||
        dependencies.selected()?.etag !== selected.etag ||
        dependencies.activeItemId() !== itemBeforeSave ||
        dependencies.editorVersion() !== editorBeforeSave
      )
        return;
      submittedDetection = {
        jobId: job.id,
        projectId: saved.id,
        mediaId: selected.id,
        activeItemId: itemBeforeSave,
        sourceFingerprint: selected.etag,
        editorVersion: editorBeforeSave,
      };
      setDetectionJob(job);
      if (job.state === "succeeded") setDetectionResult(job.candidates ?? []);
      else if (job.state === "cancelled") setDetectionStatus("Detection cancelled.");
      else if (job.state === "queued" || job.state === "running")
        setDetectionStatus(job.state === "queued" ? "Detection queued." : "Detection running.");
      else setDetectionStatus(`Detection failed${job.errorCode ? `: ${job.errorCode}.` : "."}`);
      if (job.state !== "queued" && job.state !== "running") {
        server.refreshMedia();
      }
    } catch (error) {
      if (currentOperation !== operation) return;
      setDetectionStatus(
        error instanceof ApiFailure
          ? error.code === "stale_project"
            ? "Detection is stale; save or reload the project."
            : error.code === "detection_busy"
              ? "Detection capacity is busy. Try again shortly."
              : error.code === "invalid_detection"
                ? "Detection settings were rejected. Check the sensitivity values."
                : "Detection could not be started."
          : error instanceof Error
            ? error.message
            : "Detection could not be started.",
      );
    }
  };
  const cancelDetection = async () => {
    const job = detectionJob();
    if (
      !job ||
      (job.state !== "queued" && job.state !== "running") ||
      localCancellation() === job.id
    )
      return;
    const currentOperation = ++operation;
    registry.set(submit, Atom.Interrupt);
    setLocalCancellation(job.id);
    failedCancellation = undefined;
    try {
      registry.set(cancel, job.id);
      await runEffect(readServerAtom(server, cancel));
      if (currentOperation !== operation || detectionJob()?.id !== job.id) return;
      setDetectionJob({ ...job, state: "cancelled" });
      setDetectionStatus("Detection cancelled.");
      server.refreshMedia();
    } catch (error) {
      if (currentOperation !== operation || detectionJob()?.id !== job.id) return;
      failedCancellation = job.id;
      setDetectionStatus(
        error instanceof Error ? error.message : "Detection could not be cancelled. Try again.",
      );
      setLocalCancellation();
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
    detectionLoading: () => {
      const job = detectionJob();
      return Boolean(
        job &&
        (job.state === "queued" || job.state === "running") &&
        localCancellation() !== job.id &&
        status().waiting,
      );
    },
    detectionQueryError: () => {
      const job = detectionJob();
      if (!job || job.state === "cancelled" || localCancellation() === job.id) return "";
      return Option.getOrUndefined(AsyncResult.error(status()))?.message ?? "";
    },
    clearDetectionContext,
    startDetection,
    cancelDetection,
    acceptDetection,
    rejectDetection,
    bulkAcceptDetection,
  };
}
