import { createEffect, createSignal, type Accessor, type Setter } from "solid-js";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { ApiFailure, runEffect } from "../../api";
import {
  DetectionInput as DetectionInputSchema,
  DetectionJob as DetectionJobSchema,
  type DetectionJob as GeneratedDetectionJob,
  type Job,
} from "../../generated/effect-api";
import type { ServerState } from "../app/server";
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
type DetectionInput = components["schemas"]["DetectionInput"];

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

function generatedMutation<Arg, A, E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.AtomResultFn<Arg, A, E>,
  arg: Arg,
): Effect.Effect<A, E> {
  return Effect.acquireUseRelease(
    Effect.sync(() => registry.mount(atom)),
    () => {
      registry.set(atom, arg);
      return AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
    },
    (release) =>
      Effect.sync(() => {
        registry.set(atom, Atom.Reset);
        release();
      }),
  );
}

function errorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return;
  if ("status" in error && typeof error.status === "number") return error.status;
  const reason = "reason" in error ? error.reason : undefined;
  if (reason && typeof reason === "object" && "response" in reason) {
    const response = reason.response;
    if (
      response &&
      typeof response === "object" &&
      "status" in response &&
      typeof response.status === "number"
    )
      return response.status;
  }
  const cause = "cause" in error ? error.cause : undefined;
  return cause === error ? undefined : errorStatus(cause);
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  if ("code" in error && typeof error.code === "string") return error.code;
  const nested = "error" in error ? error.error : undefined;
  if (nested && typeof nested === "object" && "code" in nested && typeof nested.code === "string")
    return nested.code;
  const cause = "cause" in error ? error.cause : undefined;
  return cause === error ? undefined : errorCode(cause);
}

function mutableDetectionJob(job: GeneratedDetectionJob): DetectionJob {
  const { candidates, ...fields } = job;
  return {
    ...fields,
    ...(candidates === undefined
      ? {}
      : { candidates: candidates.map((candidate) => ({ ...candidate })) }),
  };
}

function isUncertainSubmission(error: unknown): boolean {
  const status = errorStatus(error);
  return status === undefined
    ? errorCode(error) === undefined || errorCode(error) === "internal_error"
    : status >= 500;
}

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
  const { registry, runtime } = server;
  const [detectionStatus, setDetectionStatus] = createSignal("");
  const [detectionCandidates, setDetectionCandidates] = createSignal<Candidate[]>([]);
  let operation = 0;
  const [activeDetectionID, setActiveDetectionID] = createSignal<string>();
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
  let uncertainSubmission: { key: string; projectId: string; body: DetectionInput } | undefined;
  const submit = runtime.fn((input: { key: string; projectId: string; body: DetectionInput }) => {
    const mutation = server.generatedApi?.mutation("default", "createDetection");
    return mutation
      ? generatedMutation(registry, mutation, {
          params: { projectId: input.projectId },
          headers: { "Idempotency-Key": input.key },
          payload: input.body,
        }).pipe(
          Effect.mapError((error) => new Error("Detection submission failed.", { cause: error })),
        )
      : Effect.fail(new Error("Generated detection API is not configured."));
  });
  const cancel = runtime.fn((id: string) => {
    const mutation = server.generatedApi?.mutation("default", "cancelJob");
    return mutation
      ? generatedMutation(registry, mutation, { params: { jobId: id } }).pipe(
          Effect.mapError(
            (error) => new Error("Job could not be cancelled. Try again.", { cause: error }),
          ),
        )
      : Effect.fail(new Error("Generated detection API is not configured."));
  });
  const [status, setStatus] = createSignal<AsyncResult.AsyncResult<Job, Error>>(
    AsyncResult.initial<Job, Error>(),
  );
  const detectionJob = (): DetectionJob | undefined => {
    const id = activeDetectionID();
    const result = status();
    if (!id || !AsyncResult.isSuccess(result) || result.value.id !== id) return;
    try {
      const job = mutableDetectionJob(Schema.decodeUnknownSync(DetectionJobSchema)(result.value));
      return localCancellation() === id && (job.state === "queued" || job.state === "running")
        ? { ...job, state: "cancelled" }
        : job;
    } catch {
      return;
    }
  };
  let unsubscribeStatus: (() => void) | undefined;
  const observeJob = (id: string) => {
    unsubscribeStatus?.();
    const atom = server.observeJob(id);
    unsubscribeStatus = registry.subscribe(atom, setStatus, { immediate: true });
    void runEffect(AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true })).catch(
      () => undefined,
    );
  };
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
    if (next.id !== activeDetectionID()) return;
    const optimisticCancellation = localCancellation() === next.id;
    if (optimisticCancellation) {
      if (next.state === "queued" || next.state === "running") return;
      setLocalCancellation();
      server.setJobLocallyCancelled(next.id, false);
    }
    if (next.state === "succeeded") {
      setDetectionResult(next.candidates ?? []);
    } else if (next.state === "queued" || next.state === "running") {
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
    if (next.state === "succeeded" || next.state === "failed" || next.state === "cancelled")
      server.refreshMedia();
  };
  createEffect(() => {
    const result = status();
    const activeID = activeDetectionID();
    if (!activeID) return;
    const error = Option.getOrUndefined(AsyncResult.error(result));
    if (error && failedCancellation !== activeID) setDetectionStatus(error.message);
    const snapshot = AsyncResult.isSuccess(result) ? result.value : undefined;
    if (!snapshot) return;
    try {
      const next = Schema.decodeUnknownSync(DetectionJobSchema)(snapshot);
      receiveDetectionJob(mutableDetectionJob(next));
    } catch {
      // The generated job atom accepts the common job shape; detection details need their own schema.
    }
  });

  const clearDetectionContext = () => {
    operation++;
    registry.set(submit, Atom.Interrupt);
    registry.set(cancel, Atom.Interrupt);
    setLocalCancellation();
    failedCancellation = undefined;
    detectionReview = undefined;
    submittedDetection = undefined;
    setActiveDetectionID();
    unsubscribeStatus?.();
    unsubscribeStatus = undefined;
    setStatus(AsyncResult.initial<Job, Error>());
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
    let pendingSubmission: { key: string; projectId: string; body: DetectionInput } | undefined;
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
      const body = Schema.decodeUnknownSync(DetectionInputSchema)({
        mediaId: selected.id,
        projectItemId: itemBeforeSave,
        projectRevision: saved.revision,
        kind,
        sourceFingerprint: selected.etag,
        ...options,
      });
      const key =
        uncertainSubmission?.projectId === saved.id &&
        JSON.stringify(uncertainSubmission.body) === JSON.stringify(body)
          ? uncertainSubmission.key
          : globalThis.crypto.randomUUID();
      uncertainSubmission = undefined;
      pendingSubmission = { key, projectId: saved.id, body };
      const submittedJob = await runEffect(
        generatedMutation(registry, submit, { key, projectId: saved.id, body }),
      );
      const job = mutableDetectionJob(submittedJob);
      if (currentOperation !== operation) return;
      if (
        dependencies.projectId() !== saved.id ||
        dependencies.selected()?.id !== selected.id ||
        dependencies.selected()?.etag !== selected.etag ||
        dependencies.activeItemId() !== itemBeforeSave ||
        dependencies.editorVersion() !== editorBeforeSave
      )
        return;
      uncertainSubmission = undefined;
      // The compact submit response is validated; the shared observer owns all job snapshots.
      const observedSeed = Schema.decodeUnknownSync(DetectionJobSchema)(job);
      submittedDetection = {
        jobId: job.id,
        projectId: saved.id,
        mediaId: selected.id,
        activeItemId: itemBeforeSave,
        sourceFingerprint: selected.etag,
        editorVersion: editorBeforeSave,
      };
      setActiveDetectionID(observedSeed.id);
      observeJob(observedSeed.id);
      setDetectionStatus(
        job.state === "queued" || job.state === "running"
          ? job.state === "queued"
            ? "Detection queued."
            : "Detection running."
          : "Detection status is updating.",
      );
    } catch (error) {
      if (currentOperation !== operation) return;
      uncertainSubmission =
        pendingSubmission && isUncertainSubmission(error) ? pendingSubmission : undefined;
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
    const id = activeDetectionID();
    const job = detectionJob();
    if (
      !id ||
      localCancellation() === id ||
      (job && job.state !== "queued" && job.state !== "running" && job.state !== "cancelled")
    )
      return;
    const currentOperation = ++operation;
    setLocalCancellation(id);
    failedCancellation = undefined;
    try {
      server.setJobLocallyCancelled(id, true);
      await runEffect(generatedMutation(registry, cancel, id));
      if (currentOperation !== operation || activeDetectionID() !== id) return;
      if (localCancellation() !== id) return;
      setDetectionStatus("Detection cancellation requested.");
    } catch (error) {
      if (currentOperation !== operation || activeDetectionID() !== id) return;
      failedCancellation = id;
      setDetectionStatus(
        error instanceof Error ? error.message : "Detection could not be cancelled. Try again.",
      );
      setLocalCancellation();
      server.setJobLocallyCancelled(id, false);
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
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    detectionLoading: () => {
      const id = activeDetectionID();
      if (!id) return false;
      const job = detectionJob();
      return (
        localCancellation() === id || !job || job.state === "queued" || job.state === "running"
      );
    },
    detectionQueryError: () => {
      const id = activeDetectionID();
      if (!id || localCancellation() === id) return "";
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
