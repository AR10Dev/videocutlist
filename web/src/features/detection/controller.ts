import { isActiveState, isTerminalState } from "../queue/jobState";
import type * as EffectApiTypes from "../../generated/effect-api";
import { onCleanup, type Accessor, type Setter } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { apiErrorCode, uncertainCommandFailure } from "../../api";
import {
  DetectionInput as DetectionInputSchema,
  DetectionJob as DetectionJobSchema,
  type DetectionJob as GeneratedDetectionJob,
  type Job,
} from "../../generated/effect-api";
import { runServerMutation, type ServerState } from "../../app/server";
import {
  acceptCandidates,
  type Candidate,
  type CandidateAcceptance,
  type DetectionKind,
  skippedCandidateSummary,
} from "./model";
import type { Segment } from "../preview/model";

type Media = EffectApiTypes.Media;
type Project = EffectApiTypes.Project;
type DetectionJob = EffectApiTypes.DetectionJob;
type DetectionInput = EffectApiTypes.DetectionInput;

export type { DetectionReviewContext } from "./review";
import {
  synchronizeReview,
  newDetectionReview,
  type DetectionReview,
  type DetectionReviewContext,
  type SubmittedDetection,
} from "./review";

type DetectionSubmissionAttempt = {
  key: string;
  projectId: string;
  body: DetectionInput;
  mediaId: string;
  sourceFingerprint: string;
  activeItemId: string | undefined;
  editorVersion: number;
  kind: DetectionKind;
  options: Pick<EffectApiTypes.DetectionInput, "noiseDb" | "minDurationMs" | "sceneThreshold">;
};

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
  return uncertainCommandFailure(error, [
    "invalid_idempotency_key",
    "invalid_detection",
    "detection_busy",
    "stale_project",
    "origin_forbidden",
    "idempotency_conflict",
  ]);
}

type DetectionDependencies = {
  reviewContext: Atom.Atom<DetectionReviewContext>;
  selected: Accessor<Media | undefined>;
  activeItemId: Accessor<string | undefined>;
  projectId: Accessor<string>;
  revision: Accessor<number>;
  dirty: Accessor<boolean>;
  editorVersion: Accessor<number>;
  saveConflict: Accessor<boolean>;
  segments: Accessor<Segment[]>;
  saveProject: () => Effect.Effect<Project | undefined, unknown>;
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
  detectionStarting: Accessor<boolean>;
  startResult: Accessor<AsyncResult.AsyncResult<void, Error>>;
  cancelResult: Accessor<AsyncResult.AsyncResult<void, Error>>;
  detectionOptions: Accessor<DetectionSubmissionAttempt["options"]>;
  setDetectionOptions: Setter<DetectionSubmissionAttempt["options"]>;
  startDetection: (
    kind: DetectionKind,
    options?: Pick<EffectApiTypes.DetectionInput, "noiseDb" | "minDurationMs" | "sceneThreshold">,
  ) => void;
  cancelDetection: () => void;
  acceptDetection: (candidate: Candidate) => CandidateAcceptance;
  rejectDetection: (candidate: Candidate) => boolean;
  bulkAcceptDetection: () => CandidateAcceptance;
}

export function createDetectionController(
  server: ServerState,
  dependencies: DetectionDependencies,
): DetectionController {
  const { registry, runtime } = server;
  const reviewState = Atom.keepAlive(
    Atom.make({
      status: "",
      candidates: [] as Candidate[],
      reviewedIDs: [] as string[],
      review: undefined as DetectionReview | undefined,
      submitted: undefined as SubmittedDetection | undefined,
    }),
  );
  const observedReview = useAtomValue(() => reviewState);
  const state = () => {
    observedReview();
    return registry.get(reviewState);
  };
  const detectionStatus = () => state().status;
  const detectionCandidates = () => state().candidates;
  const setDetectionStatus: Setter<string> = (input) => {
    const status = typeof input === "function" ? input(registry.get(reviewState).status) : input;
    registry.update(reviewState, (value) => ({ ...value, status }));
    return status;
  };
  const setDetectionCandidates: Setter<Candidate[]> = (input) => {
    const value = registry.get(reviewState);
    const candidates = (typeof input === "function" ? input(value.candidates) : input).filter(
      (candidate) => !value.reviewedIDs.includes(candidate.id),
    );
    registry.update(reviewState, (value) => ({ ...value, candidates }));
    return candidates;
  };
  const submissionState = Atom.keepAlive(
    Atom.make({
      uncertain: undefined as DetectionSubmissionAttempt | undefined,
      failedCancellation: undefined as string | undefined,
      options: {} as DetectionSubmissionAttempt["options"],
    }),
  );
  const observedSubmission = useAtomValue(() => submissionState);
  const detectionOptions = () => {
    observedSubmission();
    return registry.get(submissionState).options;
  };
  const setDetectionOptions: Setter<DetectionSubmissionAttempt["options"]> = (input) => {
    const options =
      typeof input === "function" ? input(registry.get(submissionState).options) : input;
    registry.update(submissionState, (value) => ({ ...value, options }));
    return options;
  };
  const setUncertain = (uncertain?: DetectionSubmissionAttempt) =>
    registry.update(submissionState, (value) => ({ ...value, uncertain }));
  const setFailedCancellation = (failedCancellation?: string) =>
    registry.update(submissionState, (value) => ({ ...value, failedCancellation }));
  const activeID = Atom.keepAlive(Atom.make<string | undefined>(undefined));
  const cancelledID = Atom.keepAlive(Atom.make<string | undefined>(undefined));
  const observedActiveID = useAtomValue(() => activeID);
  const observedCancelledID = useAtomValue(() => cancelledID);
  const activeDetectionID = () => {
    observedActiveID();
    return registry.get(activeID);
  };
  const localCancellation = () => {
    observedCancelledID();
    return registry.get(cancelledID);
  };
  const setActiveDetectionID = (id?: string) => registry.set(activeID, id);
  const setLocalCancellation = (id?: string) => registry.set(cancelledID, id);
  let applyingDetectionEdit = false;
  const updateReview = (update: Partial<DetectionReview>) =>
    registry.update(reviewState, (value) => ({
      ...value,
      review: value.review ? { ...value.review, ...update } : undefined,
    }));
  const synchronizeDetectionReview = () => {
    const review = registry.get(reviewState).review;
    if (!review) return true;
    const next = synchronizeReview(review, registry.get(dependencies.reviewContext));
    updateReview(next);
    return !next.invalidated;
  };
  const createDetectionReview = (job: DetectionJob) => {
    if (registry.get(reviewState).review?.jobId === job.id) return;
    const context = registry.get(dependencies.reviewContext);
    const review = newDetectionReview(job, context, registry.get(reviewState).submitted);
    registry.update(reviewState, (value) => ({ ...value, review }));
  };
  const staleAcceptance = (candidates: Candidate[]): CandidateAcceptance => ({
    segments: dependencies.segments(),
    accepted: [],
    skipped: candidates.map((candidate) => ({ candidate, reason: "stale" })),
  });
  const jobResult = Atom.make((get) => {
    const id = get(activeID);
    return id ? get(server.observeJob(id)) : AsyncResult.initial<Job, Error>();
  });
  const observedJobResult = useAtomValue(() => jobResult);
  const status = () => {
    observedJobResult();
    return registry.get(jobResult);
  };
  const detectionJob = (): DetectionJob | undefined => {
    const id = activeDetectionID();
    const result = status();
    if (!id || !AsyncResult.isSuccess(result) || result.value.id !== id) return;
    try {
      const job = mutableDetectionJob(Schema.decodeUnknownSync(DetectionJobSchema)(result.value));
      return localCancellation() === id && isActiveState(job.state)
        ? { ...job, state: "cancelled" }
        : job;
    } catch {
      return;
    }
  };
  const setDetectionResult = (job: DetectionJob) => {
    createDetectionReview(job);
    const candidates = [...(job.candidates ?? [])];
    setDetectionCandidates(candidates);
    if (!registry.get(reviewState).reviewedIDs.length)
      setDetectionStatus(`${candidates.length} candidates found. Review each before accepting.`);
  };
  const receiveDetectionJob = (next: DetectionJob) => {
    if (next.id !== activeDetectionID()) return;
    const optimisticCancellation = localCancellation() === next.id;
    if (optimisticCancellation) {
      if (isActiveState(next.state)) return;
      setLocalCancellation();
      server.setJobLocallyCancelled(next.id, false);
    }
    if (next.state === "succeeded") {
      setDetectionResult(next);
    } else if (isActiveState(next.state)) {
      if (registry.get(submissionState).failedCancellation !== next.id) {
        setDetectionStatus(next.state === "queued" ? "Detection queued." : "Detection running.");
      }
    } else {
      setDetectionStatus(
        next.state === "cancelled"
          ? "Detection cancelled."
          : `Detection failed${next.errorCode ? `: ${next.errorCode}.` : "."}`,
      );
    }
    if (isTerminalState(next.state)) server.refreshMedia();
  };
  const receiveSnapshot = (result: AsyncResult.AsyncResult<Job, Error>) => {
    const activeID = activeDetectionID();
    if (!activeID) return;
    const error = Option.getOrUndefined(AsyncResult.error(result));
    if (error && registry.get(submissionState).failedCancellation !== activeID)
      setDetectionStatus(error.message);
    const snapshot = AsyncResult.isSuccess(result) ? result.value : undefined;
    if (!snapshot) return;
    try {
      const next = Schema.decodeUnknownSync(DetectionJobSchema)(snapshot);
      receiveDetectionJob(mutableDetectionJob(next));
    } catch {
      // The generated job atom accepts the common job shape; detection details need their own schema.
    }
  };

  // The observation atom owns its subscription; changing active identity releases it.
  const observation = Atom.make((get) => {
    const id = get(activeID);
    if (id) {
      get.subscribe(dependencies.reviewContext, () => {
        if (!applyingDetectionEdit) synchronizeDetectionReview();
      });
      get.subscribe(server.observeJob(id), receiveSnapshot, { immediate: true });
    }
  });
  const releaseObservation = registry.mount(observation);
  onCleanup(releaseObservation);

  const resetReview = () => {
    const cancelled = registry.get(cancelledID);
    if (cancelled) server.setJobLocallyCancelled(cancelled, false);
    setLocalCancellation();
    setFailedCancellation();
    registry.set(reviewState, {
      status: "",
      candidates: [],
      reviewedIDs: [],
      review: undefined,
      submitted: undefined,
    });
    setActiveDetectionID();
  };
  const clearDetectionContext = () => {
    registry.set(start, Atom.Interrupt);
    registry.set(cancel, Atom.Interrupt);
    resetReview();
  };
  const sameContext = (before: DetectionReviewContext) =>
    dependencies.projectId() === before.projectId &&
    dependencies.selected()?.id === before.selected?.id &&
    dependencies.selected()?.etag === before.selected?.etag &&
    dependencies.activeItemId() === before.activeItemId &&
    dependencies.editorVersion() === before.editorVersion &&
    !dependencies.saveConflict();
  const start = runtime.fn(
    (input: { kind: DetectionKind; options: DetectionSubmissionAttempt["options"] }) =>
      Effect.gen(function* () {
        const { kind, options } = input;
        const before = registry.get(dependencies.reviewContext);
        const retry = registry.get(submissionState).uncertain;
        const retryUnchanged = Boolean(
          retry &&
          sameContext(before) &&
          retry.projectId === before.projectId &&
          retry.mediaId === before.selected?.id &&
          retry.sourceFingerprint === before.selected?.etag &&
          retry.activeItemId === before.activeItemId &&
          retry.editorVersion === before.editorVersion &&
          retry.kind === kind &&
          retry.options.noiseDb === options.noiseDb &&
          retry.options.minDurationMs === options.minDurationMs &&
          retry.options.sceneThreshold === options.sceneThreshold &&
          dependencies.revision() === retry.body.projectRevision &&
          !dependencies.dirty(),
        );
        // A context switch interrupts the client scope, never the durable server job.
        yield* Effect.acquireRelease(
          Effect.sync(() =>
            registry.subscribe(dependencies.reviewContext, () => {
              if (!sameContext(before)) clearDetectionContext();
            }),
          ),
          (release) => Effect.sync(release),
        );
        setDetectionStatus(
          retryUnchanged ? `Starting ${kind} detection…` : "Saving project before detection…",
        );
        let pending: DetectionSubmissionAttempt | undefined;
        const workflow = Effect.gen(function* () {
          const saved =
            retryUnchanged && retry
              ? { id: retry.projectId, revision: retry.body.projectRevision }
              : yield* dependencies
                  .saveProject()
                  .pipe(
                    Effect.mapError(
                      () =>
                        new Error(
                          "Detection was not started. Save from the project header and resolve any reported errors.",
                        ),
                    ),
                  );
          const selected = dependencies.selected();
          if (!saved || !selected)
            return yield* Effect.fail(
              new Error(
                "Detection was not started. Save from the project header and resolve any reported errors.",
              ),
            );
          if (saved.id !== before.projectId || !sameContext(before))
            return yield* Effect.fail(new Error("Detection is stale; save or reload the project."));
          setDetectionStatus(`Starting ${kind} detection…`);
          const body =
            retryUnchanged && retry
              ? retry.body
              : yield* Schema.decodeUnknownEffect(DetectionInputSchema)({
                  mediaId: selected.id,
                  projectItemId: before.activeItemId,
                  projectRevision: saved.revision,
                  kind,
                  sourceFingerprint: selected.etag,
                  ...options,
                }).pipe(
                  Effect.mapError(
                    () =>
                      new Error("Detection settings were rejected. Check the sensitivity values."),
                  ),
                );
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              registry.subscribe(dependencies.reviewContext, (context) => {
                if (context.revision !== body.projectRevision) clearDetectionContext();
              }),
            ),
            (release) => Effect.sync(release),
          );
          const key = retryUnchanged && retry ? retry.key : globalThis.crypto.randomUUID();
          pending = {
            key,
            projectId: saved.id,
            body,
            mediaId: selected.id,
            sourceFingerprint: selected.etag,
            activeItemId: before.activeItemId,
            editorVersion: before.editorVersion,
            kind,
            options: { ...options },
          };
          // Client interruption cannot prove that Go did not admit this command.
          setUncertain(pending);
          const result = yield* runServerMutation(
            registry,
            server.generatedApi.mutation("default", "createDetection"),
            {
              params: { projectId: saved.id },
              headers: { "Idempotency-Key": key },
              payload: body,
            },
          );
          const job = mutableDetectionJob(
            yield* Schema.decodeUnknownEffect(DetectionJobSchema)(result),
          );
          setUncertain();
          if (!sameContext(before) || dependencies.revision() !== body.projectRevision) return;
          registry.update(reviewState, (value) => ({
            ...value,
            submitted: {
              jobId: job.id,
              projectId: saved.id,
              mediaId: selected.id,
              activeItemId: before.activeItemId,
              sourceFingerprint: selected.etag,
              editorVersion: before.editorVersion,
            },
          }));
          setDetectionStatus(
            job.state === "queued"
              ? "Detection queued."
              : job.state === "running"
                ? "Detection running."
                : "Detection status is updating.",
          );
          setActiveDetectionID(job.id);
        });
        yield* workflow.pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.interrupt;
            const error = Cause.squash(cause);
            if (pending && !isUncertainSubmission(error)) setUncertain();
            const code = apiErrorCode(error);
            const message =
              code === "stale_project"
                ? "Detection is stale; save or reload the project."
                : code === "detection_busy"
                  ? "Detection capacity is busy. Try again shortly."
                  : code === "invalid_detection"
                    ? "Detection settings were rejected. Check the sensitivity values."
                    : error instanceof Error && !pending
                      ? error.message
                      : "Detection could not be started.";
            setDetectionStatus(message);
            return Effect.fail(new Error(message, { cause: error }));
          }),
        );
      }).pipe(Effect.scoped),
  );
  const cancel = runtime.fn((id: string) =>
    Effect.gen(function* () {
      setLocalCancellation(id);
      setFailedCancellation();
      server.setJobLocallyCancelled(id, true);
      yield* runServerMutation(registry, server.generatedApi.mutation("default", "cancelJob"), {
        params: { jobId: id },
      }).pipe(
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.interrupt;
          const error = Cause.squash(cause);
          if (registry.get(activeID) === id && registry.get(cancelledID) === id) {
            setFailedCancellation(id);
            setLocalCancellation();
            server.setJobLocallyCancelled(id, false);
            setDetectionStatus("Job could not be cancelled. Try again.");
          }
          return Effect.fail(new Error("Job could not be cancelled. Try again.", { cause: error }));
        }),
      );
      if (registry.get(activeID) === id && registry.get(cancelledID) === id)
        setDetectionStatus("Detection cancellation requested.");
    }),
  );
  const releaseStart = registry.mount(start);
  const releaseCancel = registry.mount(cancel);
  onCleanup(() => {
    clearDetectionContext();
    releaseStart();
    releaseCancel();
  });
  const observedStart = useAtomValue(() => start);
  const observedCancel = useAtomValue(() => cancel);
  const startResult = () => {
    observedStart();
    return registry.get(start);
  };
  const cancelResult = () => {
    observedCancel();
    return registry.get(cancel);
  };
  const startDetection = (kind: DetectionKind, options = detectionOptions()) => {
    clearDetectionContext();
    registry.set(start, { kind, options: { ...options } });
  };
  const cancelDetection = () => {
    const id = registry.get(activeID);
    const job = detectionJob();
    if (
      !id ||
      registry.get(cancelledID) === id ||
      (job && job.state !== "queued" && job.state !== "running" && job.state !== "cancelled")
    )
      return;
    registry.set(cancel, id);
  };
  const recordLocalDetectionEdit = () => {
    const review = registry.get(reviewState).review;
    if (!review || review.invalidated) return;
    updateReview({
      pendingLocalSave: true,
      editorVersion: registry.get(dependencies.reviewContext).editorVersion,
    });
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
    candidates = candidates.filter(
      (candidate) => !registry.get(reviewState).reviewedIDs.includes(candidate.id),
    );
    if (!synchronizeDetectionReview()) return staleAcceptance(candidates);
    const selected = dependencies.selected();
    if (!selected) return { segments: dependencies.segments(), accepted: [], skipped: [] };
    return acceptCandidates(
      candidates,
      {
        id: dependencies.projectId(),
        mediaId: selected.id,
        revision: registry.get(reviewState).review?.baselineRevision ?? dependencies.revision(),
        segments: dependencies.segments(),
      },
      selected.durationMs,
    );
  };
  const command = <Args extends unknown[], A>(transition: (...args: Args) => A) => {
    const action = runtime.fn((args: Args) => Effect.sync(() => transition(...args)), {
      concurrent: true,
    });
    return (...args: Args): A => {
      registry.set(action, args);
      const result = registry.get(action);
      if (!AsyncResult.isSuccess(result))
        throw new Error("Detection review command did not complete synchronously.");
      return result.value;
    };
  };
  const acceptDetection = command((candidate: Candidate): CandidateAcceptance => {
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
    registry.update(reviewState, (value) => ({
      ...value,
      reviewedIDs: [...new Set([...value.reviewedIDs, candidate.id])],
    }));
    setDetectionCandidates((items: Candidate[]) =>
      items.filter((item) => item.id !== candidate.id),
    );
    setDetectionStatus("Candidate accepted; save the project to persist it.");
    return result;
  });
  const rejectDetection = command((candidate: Candidate) => {
    registry.update(reviewState, (value) => ({
      ...value,
      reviewedIDs: [...new Set([...value.reviewedIDs, candidate.id])],
    }));
    setDetectionCandidates((items: Candidate[]) =>
      items.filter((item) => item.id !== candidate.id),
    );
    setDetectionStatus("Candidate dismissed.");
    return true;
  });
  const bulkAcceptDetection = command((): CandidateAcceptance => {
    const result = acceptanceFor(detectionCandidates());
    if (!result.accepted.length) {
      const skipped = skippedCandidateSummary(result.skipped);
      setDetectionStatus(
        skipped ? `No candidates accepted; skipped ${skipped}.` : "No candidates to accept.",
      );
      return result;
    }
    applyAcceptedSegments(result.segments);
    registry.update(reviewState, (value) => ({
      ...value,
      reviewedIDs: [
        ...new Set([...value.reviewedIDs, ...result.accepted.map((candidate) => candidate.id)]),
      ],
    }));
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
  });

  return {
    detectionJob,
    detectionStarting: () => startResult().waiting,
    startResult,
    cancelResult,
    detectionOptions,
    setDetectionOptions,
    detectionStatus,
    setDetectionStatus,
    detectionCandidates,
    setDetectionCandidates,
    detectionLoading: () => {
      const id = activeDetectionID();
      if (!id) return false;
      const job = detectionJob();
      return localCancellation() === id || !job || isActiveState(job.state);
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
