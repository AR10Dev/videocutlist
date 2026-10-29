import { onCleanup, type Accessor } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect } from "effect";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as EffectApiTypes from "../../generated/effect-api";
import { Batch as BatchSchema } from "../../generated/effect-api";
import type { Batch as ObservedBatch } from "../../generated/effect-api";
import { uncertainCommandFailure } from "../../api";
import { requestErrorMessage, resourceErrorMessage } from "./errors";
import { runGeneratedRequest, useServerAtom, type ServerState } from "../../app/server";
import { isActiveState, isTerminalState } from "../queue/jobState";
import { exportFailureMessage } from "../queue/jobUi";
import {
  isBatchActive,
  isJobActive,
  idempotencyKeyForAttempt,
  selectBatchJob,
  decodeBatchSeeds,
} from "./queueResponse";

type Batch = EffectApiTypes.Batch;
export type ExportQueueContext = {
  projectId: string;
  selectedMediaId?: string;
  revision: number;
  editVersion: number;
  generation?: number;
};
type ChildJobContext = {
  projectId: string;
  mediaId?: string;
  revision: number;
  batchId?: string;
  exportJobId?: string;
  editorVersion: number;
  generation: number;
  projectGeneration?: number;
};
export function createExportQueue(deps: {
  server: ServerState;
  context: Atom.Atom<ExportQueueContext>;
  currentContext: Accessor<ExportQueueContext>;
}) {
  const { registry, runtime, generatedApi } = deps.server;
  const batchIDsAtom = Atom.keepAlive(Atom.make<string[]>([]));
  const batchIdAtom = Atom.keepAlive(Atom.make<string | undefined>(undefined));
  const cancelledBatchIDsAtom = Atom.keepAlive(Atom.make<ReadonlySet<string>>(new Set<string>()));
  const cancelledChildJobIDsAtom = Atom.keepAlive(
    Atom.make<ReadonlySet<string>>(new Set<string>()),
  );
  const batchId = useAtomValue(() => batchIdAtom);
  const setBatchId = (id: string | undefined) => registry.set(batchIdAtom, id);
  const setBatchIDs = (update: string[] | ((ids: string[]) => string[])) =>
    registry.set(
      batchIDsAtom,
      typeof update === "function" ? update(registry.get(batchIDsAtom)) : update,
    );
  const setCancelledBatchIDs = (update: (ids: ReadonlySet<string>) => ReadonlySet<string>) =>
    registry.update(cancelledBatchIDsAtom, update);
  const setCancelledChildJobIDs = (update: (ids: ReadonlySet<string>) => ReadonlySet<string>) =>
    registry.update(cancelledChildJobIDsAtom, update);
  const projectCancellation = (
    batch: Batch,
    batches: ReadonlySet<string>,
    children: ReadonlySet<string>,
  ): Batch => {
    const locallyCancelled = batches.has(batch.batchId);
    if (!locallyCancelled && !batch.jobs.some((job) => children.has(job.id))) return batch;
    return {
      ...batch,
      state: locallyCancelled && isActiveState(batch.state) ? "cancelled" : batch.state,
      jobs: batch.jobs.map((job) =>
        isJobActive(job) && (locallyCancelled || children.has(job.id))
          ? { ...job, state: "cancelled" as const }
          : job,
      ),
    };
  };
  const observeBatchSnapshot = (id: string, initial?: ObservedBatch) =>
    deps.server.observeBatch(id, initial);
  const currentBatchResultAtom = Atom.make((get) => {
    const id = get(batchIdAtom);
    return id ? get(observeBatchSnapshot(id)) : AsyncResult.initial<ObservedBatch, Error>();
  });
  const currentBatchResult = useAtomValue(() => currentBatchResultAtom);
  const displayedBatch = (get: Atom.AtomContext, snapshot: ObservedBatch): Batch =>
    // SAFETY: Shared observation schema-validates this readonly UI projection.
    projectCancellation(snapshot, get(cancelledBatchIDsAtom), get(cancelledChildJobIDsAtom));
  const currentBatchAtom = Atom.make((get) => {
    const result = get(currentBatchResultAtom);
    return AsyncResult.isSuccess(result) ? displayedBatch(get, result.value) : undefined;
  });
  const rawBatchesAtom = Atom.make((get) =>
    get(batchIDsAtom).flatMap((id) => {
      const result = get(observeBatchSnapshot(id));
      return AsyncResult.isSuccess(result) ? [result.value] : [];
    }),
  );
  const batchesAtom = Atom.make((get) =>
    get(rawBatchesAtom).map((batch) => displayedBatch(get, batch)),
  );
  const batches = useAtomValue(() => batchesAtom);
  const exportJobAtom = Atom.make((get) => selectBatchJob(get(currentBatchAtom)?.jobs ?? []));
  const exportJob = useAtomValue(() => exportJobAtom);
  const batchJobsAtom = Atom.make((get) => get(currentBatchAtom)?.jobs ?? []);
  const batchJobs = useAtomValue(() => batchJobsAtom);
  const exportRevisionAtom = Atom.make((get) => get(currentBatchAtom)?.projectRevision);
  const exportRevision = useAtomValue(() => exportRevisionAtom);
  const exportStatusAtom = Atom.keepAlive(
    Atom.make({ message: "", snapshot: registry.get(currentBatchResultAtom) }),
  );
  const statusProjectionAtom = Atom.make((get) => {
    const notice = get(exportStatusAtom);
    if (notice.snapshot === get(currentBatchResultAtom)) return notice.message;
    const batch = get(currentBatchAtom);
    if (!batch) return notice.message;
    if (batch.state === "queued") return "Export queued.";
    if (batch.state === "running")
      return `Export batch running (${Math.round(batch.progress * 100)}%).`;
    if (batch.state === "succeeded") return "Export complete.";
    if (batch.state === "cancelled") return "Export cancelled.";
    const failedJob = batch.jobs.find((job) => job.state === "failed");
    return failedJob ? exportFailureMessage(failedJob.errorCode) : "Export batch failed.";
  });
  const exportStatus = useAtomValue(() => statusProjectionAtom);
  const setExportStatus = (message: string) =>
    registry.set(exportStatusAtom, { message, snapshot: registry.get(currentBatchResultAtom) });
  const cancellationEpoch = Atom.keepAlive(Atom.make(0));
  const cancellationContext = Atom.make((get) => {
    const context = get(deps.context);
    return JSON.stringify([
      get(cancellationEpoch),
      context.projectId,
      context.generation,
      context.revision,
      context.editVersion,
      get(deps.context).selectedMediaId,
    ]);
  });
  const invalidatedTerminalJobsAtom = Atom.keepAlive(
    Atom.make<ReadonlySet<string>>(new Set<string>()),
  );
  const retryJobIDsAtom = Atom.keepAlive(Atom.make<ReadonlySet<string>>(new Set<string>()));
  const childJobContextEpoch = Atom.keepAlive(Atom.make(0));
  const batchListAtom = generatedApi.query("default", "listBatches", { query: { limit: 50 } });
  const batchList = useServerAtom(() => batchListAtom);
  const cancellationCommands = Atom.family((target: string) =>
    Atom.keepAlive(
      runtime.fn((_: void, get) => {
        const context = get(cancellationContext);
        const [kind, id] = target.split(":");
        const batch = kind === "batch";
        const command = cancellationCommands(target);
        get.subscribe(cancellationContext, (next) => {
          if (next !== context) registry.set(command, Atom.Interrupt);
        });
        const current = () => registry.get(cancellationContext) === context;
        const mark = (cancelled: boolean) => {
          if (batch) {
            markLocallyCancelledBatch(id, cancelled);
            deps.server.setBatchLocallyCancelled(id, cancelled);
          } else {
            markLocallyCancelledJob(id, cancelled);
            deps.server.setJobLocallyCancelled(id, cancelled);
          }
        };
        const message = batch
          ? "Export batch cancellation requested."
          : "Export job cancellation requested.";
        return Effect.gen(function* () {
          mark(true);
          setExportStatus(message);
          yield* runGeneratedRequest(
            deps.server,
            generatedApi.use((client) =>
              batch
                ? client.cancelBatch({ params: { batchId: id } })
                : client.cancelJob({ params: { jobId: id } }),
            ),
          ).pipe(
            Effect.mapError(
              () =>
                new Error(
                  batch
                    ? "Export batch could not be cancelled. Try again."
                    : "Export job could not be cancelled. Try again.",
                ),
            ),
          );
          if (current()) refreshBatches();
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (!current()) return;
              mark(false);
              refreshBatches();
              setExportStatus(error.message);
            }),
          ),
        );
      }),
    ),
  );
  const pendingChildCancellationsAtom = Atom.make(
    (get) =>
      new Set(
        [...get(cancelledChildJobIDsAtom)].filter(
          (id) => get(cancellationCommands(`job:${id}`)).waiting,
        ),
      ),
  );
  const pendingChildCancellations = useAtomValue(() => pendingChildCancellationsAtom);
  const cancellationResult = (target: string) => registry.get(cancellationCommands(target));
  const cancellationPendingAtom = Atom.make((get) => {
    const id = get(batchIdAtom);
    return id ? get(cancellationCommands(`batch:${id}`)).waiting : false;
  });
  const exportCancellationPending = useAtomValue(() => cancellationPendingAtom);
  const dispatchCancellation = (target: string) => {
    if (!cancellationResult(target).waiting) registry.set(cancellationCommands(target), undefined);
  };
  const uncertainRetries = Atom.family((_id: string) =>
    Atom.keepAlive(Atom.make<{ key: string; body: { jobId: string } } | undefined>(undefined)),
  );
  const isUncertainRetryFailure = (error: unknown) =>
    uncertainCommandFailure(error, [
      "idempotency_conflict",
      "invalid_idempotency_key",
      "job_not_retryable",
      "not_found",
      "origin_forbidden",
    ]);
  const refreshBatches = () => registry.refresh(batchListAtom);
  const childJobActionIsCurrent = (context: ChildJobContext) =>
    context.generation === registry.get(childJobContextEpoch) &&
    context.projectGeneration === registry.get(deps.context).generation &&
    context.batchId === batchId() &&
    context.projectId === deps.currentContext().projectId &&
    context.mediaId === deps.currentContext().selectedMediaId &&
    context.revision === deps.currentContext().revision &&
    context.editorVersion === deps.currentContext().editVersion;
  const activeExportContextIsCurrent = (id: string, context: ChildJobContext) =>
    childJobActionIsCurrent(context) &&
    (exportJob()?.id === undefined || exportJob()?.id === (context.exportJobId ?? id));
  const childJobBatchId = (id: string, requestedBatchId?: string) =>
    batches().find(
      (batch) =>
        batch.batchId === requestedBatchId ||
        (!requestedBatchId && batch.jobs.some((job) => job.id === id)),
    )?.batchId ??
    requestedBatchId ??
    (batchJobs().some((job) => job.id === id) || exportJob()?.id === id ? batchId() : undefined);
  const markLocallyCancelledBatch = (id: string, cancelled: boolean) => {
    setCancelledBatchIDs((current) => {
      const next = new Set(current);
      if (cancelled) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const markLocallyCancelledJob = (id: string, cancelled: boolean) => {
    setCancelledChildJobIDs((current) => {
      const next = new Set(current);
      if (cancelled) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const ingestBatchList = () => {
    const result = registry.get(batchListAtom);
    if (!AsyncResult.isSuccess(result)) return;
    const snapshots = decodeBatchSeeds(Array.isArray(result.value.items) ? result.value.items : []);
    for (const snapshot of snapshots) observeBatchSnapshot(snapshot.batchId, snapshot);
    const ids = snapshots.map((snapshot) => snapshot.batchId);
    const current = registry.get(batchIdAtom);
    setBatchIDs([...new Set([...(current && !ids.includes(current) ? [current] : []), ...ids])]);
    if (!current) {
      const active = snapshots.find((snapshot) => {
        const observed = registry.get(observeBatchSnapshot(snapshot.batchId));
        // SAFETY: Shared observation schema-validates the readonly snapshot.
        return AsyncResult.isSuccess(observed) && isBatchActive(observed.value);
      });
      if (active) setBatchId(active.batchId);
    }
  };
  const stopBatchList = registry.subscribe(batchListAtom, ingestBatchList, { immediate: true });
  const invalidateTerminalJobs = () => {
    const jobs = registry
      .get(rawBatchesAtom)
      .flatMap((batch) => batch.jobs)
      .filter(
        (job) =>
          isTerminalState(job.state) && !registry.get(invalidatedTerminalJobsAtom).has(job.id),
      );
    if (!jobs.length) return;
    registry.update(
      invalidatedTerminalJobsAtom,
      (ids) => new Set([...ids, ...jobs.map((job) => job.id)]),
    );
    deps.server.refreshMedia();
    refreshBatches();
  };
  const stopTerminalJobs = registry.subscribe(rawBatchesAtom, invalidateTerminalJobs, {
    immediate: true,
  });
  const cancelExport = () => {
    const id = registry.get(batchIdAtom);
    if (id && (batchJobs().some(isJobActive) || isJobActive(exportJob())))
      dispatchCancellation(`batch:${id}`);
  };
  const cancelBatch = (id: string) => dispatchCancellation(`batch:${id}`);
  const currentBatchError = () => {
    const result = currentBatchResult();
    if (!AsyncResult.isFailure(result)) return "";
    const cause = Cause.squash(result.cause);
    return requestErrorMessage(cause, "Request could not be completed.");
  };
  const childJobContext = (): ChildJobContext => ({
    projectId: deps.currentContext().projectId,
    mediaId: deps.currentContext().selectedMediaId,
    revision: deps.currentContext().revision,
    batchId: batchId(),
    exportJobId: exportJob()?.id,
    editorVersion: deps.currentContext().editVersion,
    generation: registry.get(childJobContextEpoch),
    projectGeneration: registry.get(deps.context).generation,
  });
  const retryCommands = Atom.family((id: string) =>
    Atom.keepAlive(
      runtime.fn((requestedBatchId: string | undefined) =>
        Effect.gen(function* () {
          const jobBatchId = childJobBatchId(id, requestedBatchId);
          const context = childJobContext();
          const body = { jobId: id };
          const identity = uncertainRetries(id);
          const key = idempotencyKeyForAttempt(registry.get(identity), body, () =>
            globalThis.crypto.randomUUID(),
          );
          // Record before sending: interruption cannot establish whether Go admitted the retry.
          registry.set(identity, { key, body });
          yield* Effect.gen(function* () {
            const response = yield* runGeneratedRequest(
              deps.server,
              generatedApi.use((client) =>
                client.retryJob({
                  params: { jobId: id },
                  headers: { "Idempotency-Key": key },
                }),
              ),
            ).pipe(
              Effect.tapError((error) =>
                Effect.sync(() => {
                  if (!isUncertainRetryFailure(error)) registry.set(identity, undefined);
                }),
              ),
            );
            const validatedBatch = yield* Schema.decodeUnknownEffect(BatchSchema)(response);
            registry.set(identity, undefined);
            observeBatchSnapshot(validatedBatch.batchId, validatedBatch);
            setBatchIDs((ids) => [
              validatedBatch.batchId,
              ...ids.filter((batchID) => batchID !== validatedBatch.batchId),
            ]);
            if (!childJobActionIsCurrent(context)) return;
            refreshBatches();
            if (
              activeExportContextIsCurrent(id, context) &&
              (jobBatchId === context.batchId || context.exportJobId === id)
            )
              setBatchId(validatedBatch.batchId);
            setExportStatus("Export retry queued as a new job.");
          }).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                if (childJobActionIsCurrent(context))
                  setExportStatus(
                    requestErrorMessage(error, "Export job could not be retried. Try again."),
                  );
              }),
            ),
          );
        }),
      ),
    ),
  );
  const pendingRetriesAtom = Atom.make(
    (get) => new Set([...get(retryJobIDsAtom)].filter((id) => get(retryCommands(id)).waiting)),
  );
  const pendingRetries = useAtomValue(() => pendingRetriesAtom);
  const cancelChildJob = (id: string, _requestedBatchId?: string) => {
    if (!registry.get(retryCommands(id)).waiting) dispatchCancellation(`job:${id}`);
  };
  const retryChildJob = (id: string, requestedBatchId?: string) => {
    if (registry.get(retryCommands(id)).waiting || cancellationResult(`job:${id}`).waiting) return;
    registry.update(retryJobIDsAtom, (ids) => new Set([...ids, id]));
    registry.set(retryCommands(id), requestedBatchId);
  };
  const beginSubmission = () => {
    registry.update(childJobContextEpoch, (epoch) => epoch + 1);
    // A new client attempt releases old cancellation requests, not server jobs.
    registry.update(cancellationEpoch, (epoch) => epoch + 1);
    registry.get(cancellationContext);
  };
  const clearContext = () => {
    registry.update(cancellationEpoch, (epoch) => epoch + 1);
    registry.get(cancellationContext);
    registry.update(childJobContextEpoch, (epoch) => epoch + 1);
    setBatchId(undefined);
    setExportStatus("");
  };
  const acceptSubmission = (batch: Batch) => {
    observeBatchSnapshot(batch.batchId, batch);
    setBatchIDs((ids) => [batch.batchId, ...ids.filter((id) => id !== batch.batchId)]);
    setBatchId(batch.batchId);
    refreshBatches();
  };
  onCleanup(() => {
    stopBatchList();
    stopTerminalJobs();
    clearContext();
  });
  return {
    beginSubmission,
    clearContext,
    acceptSubmission,
    setStatus: setExportStatus,
    view: {
      batches,
      exportJob,
      batchJobs,
      batchId,
      exportRevision,
      exportStatus,
      exportCancellationPending,
      cancellationCommands,
      retryCommands,
      childJobPending: (id: string) =>
        pendingRetries().has(id) || pendingChildCancellations().has(id),
      batchesLoading: () => batchList.waiting() && !batchList.value(),
      batchesRefreshing: () => batchList.waiting(),
      batchesError: () =>
        resourceErrorMessage(batchList.result(), "Request could not be completed."),
      refreshBatches,
      batchLoading: () => Boolean(batchId()) && currentBatchResult().waiting,
      batchError: currentBatchError,
      exportJobLoading: () => Boolean(exportJob()?.id) && currentBatchResult().waiting,
      exportJobError: currentBatchError,
      cancelExport,
      cancelBatch,
      cancelChildJob,
      retryChildJob,
    },
  };
}
