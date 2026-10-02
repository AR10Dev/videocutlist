import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  type Accessor,
  type Setter,
} from "solid-js";
import { useAtomSet, useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Exit } from "effect";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { ApiFailure, runEffect, type ApiClient } from "../../api";
import { readServerAtom, useServerAtom, type ServerState } from "../app/server";
import type { components } from "../../generated/api";
import { Batch as BatchSchema } from "../../generated/effect-api";
import type { Batch as ObservedBatch } from "../../generated/effect-api";
import type { EditableProjectItem, ExportContainer } from "../projects/model";
import type { Segment } from "../preview/model";
import { validFilenameTemplateLength, type AppSettings } from "../settings/model";
import { exportFailureMessage } from "../queue/jobUi";
import {
  isBatchActive,
  isJobActive,
  idempotencyKeyForAttempt,
  parseBatchExportSubmission,
  selectBatchJob,
} from "./queueResponse";
import { destinationIsConfigured, lastDestinationId, rememberDestination } from "./destination";

type Media = components["schemas"]["Media"];
type Destination = components["schemas"]["Destination"];
type ExportJob = components["schemas"]["Job"];
type Batch = components["schemas"]["Batch"];
type ExportPreflight = import("../../generated/effect-api").ExportPreflight;
type ExportCancellation = {
  batchId: string;
  jobId: string;
};
type ChildJobContext = {
  projectId: string;
  mediaId?: string;
  revision: number;
  batchId?: string;
  exportJobId?: string;
  editorVersion: number;
  generation: number;
};
const publicApiError = (
  failure: unknown,
): { code: string; message: string; requestId: string } | undefined => {
  if (typeof failure !== "object" || failure === null || !("error" in failure)) return;
  const error = failure.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("code" in error) ||
    typeof error.code !== "string" ||
    !("message" in error) ||
    typeof error.message !== "string" ||
    !("requestId" in error) ||
    typeof error.requestId !== "string"
  )
    return;
  return { code: error.code, message: error.message, requestId: error.requestId };
};

const requestErrorMessage = (failure: unknown, fallback: string): string => {
  if (failure instanceof Error) return failure.message;
  return publicApiError(failure)?.message ?? fallback;
};

const preflightFailureMessage = (failure: unknown): string => {
  if (failure instanceof ApiFailure)
    return `Export preflight failed (${failure.status}). Try again.`;
  const error = publicApiError(failure);
  return error
    ? `Export preflight failed (${error.code}): ${error.message} (request ${error.requestId})`
    : "Export preflight could not be reached. Try again.";
};

type Track = {
  index: number;
  type: string;
  codec: string;
  language?: string;
  disposition?: string[];
};
export type ExportScope = "active" | "selected";

export function createExportController(deps: {
  api: ApiClient;
  server: ServerState;
  selected: Accessor<Media | undefined>;
  projectId: Accessor<string>;
  revision: Accessor<number>;
  dirty: Accessor<boolean>;
  setDirty: Setter<boolean>;
  editorVersion: Accessor<number>;
  status: Accessor<string>;
  projectItems: Accessor<EditableProjectItem[]>;
  setProjectItems: Setter<EditableProjectItem[]>;
  activeItemId: Accessor<string | undefined>;
  editableItems: Accessor<EditableProjectItem[]>;
  segments: Accessor<Segment[]>;
  tracks: Accessor<Track[]>;
  saveProject: () => Promise<components["schemas"]["Project"] | undefined>;
  settings: Accessor<AppSettings>;
  markDirty: () => void;
  saveSettings: (changes: Partial<AppSettings>) => void;
}) {
  const [selectedExportItems, setSelectedExportItems] = createSignal<string[]>([]);
  const [exportScope, setExportScope] = createSignal<ExportScope>("active");
  const exportItemIDs = () => {
    if (exportScope() === "selected") return selectedExportItems();
    const currentItem = deps.projectItems().find((entry) => entry.media.id === deps.selected()?.id);
    return currentItem ? [currentItem.id] : [];
  };
  const registry = deps.server.registry;
  const runtime = deps.server.runtime;
  const [batchIDs, setBatchIDs] = createSignal<string[]>([]);
  const [batchId, setBatchId] = createSignal<string>();
  const [cancelledBatchIDs, setCancelledBatchIDs] = createSignal<ReadonlySet<string>>(new Set());
  const [cancelledChildJobIDs, setCancelledChildJobIDs] = createSignal<ReadonlySet<string>>(
    new Set(),
  );
  const projectCancellation = (batch: Batch): Batch => {
    const locallyCancelled = cancelledBatchIDs().has(batch.batchId);
    if (!locallyCancelled && !batch.jobs.some((job) => cancelledChildJobIDs().has(job.id)))
      return batch;
    const jobs = batch.jobs.map((job) =>
      isJobActive(job) && (locallyCancelled || cancelledChildJobIDs().has(job.id))
        ? { ...job, state: "cancelled" as const }
        : job,
    );
    return {
      ...batch,
      state:
        locallyCancelled && (batch.state === "queued" || batch.state === "running")
          ? "cancelled"
          : batch.state,
      jobs,
    };
  };
  const batchSnapshotAccessors = new Map<
    string,
    Accessor<AsyncResult.AsyncResult<ObservedBatch, Error>>
  >();
  const batchSnapshotUnsubscribers = new Set<() => void>();
  const observeBatchSnapshot = (id: string, initial?: ObservedBatch) => {
    const atom = deps.server.observeBatch(id, initial);
    let snapshot = batchSnapshotAccessors.get(id);
    if (!snapshot) {
      const [value, setValue] = createSignal(registry.get(atom));
      const unsubscribe = registry.subscribe(atom, setValue, { immediate: true });
      batchSnapshotAccessors.set(id, value);
      batchSnapshotUnsubscribers.add(unsubscribe);
      snapshot = value;
    }
    return snapshot;
  };
  const batchSnapshot = (id: string) => observeBatchSnapshot(id)();
  const emptyBatchSnapshot = AsyncResult.initial<ObservedBatch, Error>();
  const currentBatchResult = createMemo(() =>
    batchId() ? batchSnapshot(batchId()!) : emptyBatchSnapshot,
  );
  const currentBatch = createMemo(() => {
    const result = currentBatchResult();
    if (!AsyncResult.isSuccess(result)) return;
    // SAFETY: The workspace owner schema-validated this readonly snapshot; this is a read-only UI projection.
    return projectCancellation(result.value as unknown as Batch);
  });
  const batches = createMemo(() =>
    batchIDs().flatMap((id) => {
      const result = batchSnapshot(id);
      if (!AsyncResult.isSuccess(result)) return [];
      // SAFETY: The workspace owner schema-validated this readonly snapshot; this is a read-only UI projection.
      return [projectCancellation(result.value as unknown as Batch)];
    }),
  );
  const exportJob = createMemo(() => selectBatchJob(currentBatch()?.jobs ?? []));
  const batchJobs = createMemo(() => currentBatch()?.jobs ?? []);
  const exportRevision = createMemo(() => currentBatch()?.projectRevision);
  const [exportStatus, setExportStatus] = createSignal("");
  const [exportMode, setExportMode] = createSignal<"merge" | "separate">("merge");
  const [exportSelection, setExportSelection] = createSignal<"segments" | "gaps">("segments");
  const [cutStrategy, setCutStrategy] = createSignal(deps.settings().cutStrategy);
  const [exportContainer, setExportContainerState] = createSignal<ExportContainer>("mkv");
  let containerChoiceExplicit = false;
  const setExportContainer: Setter<ExportContainer> = (value) => {
    containerChoiceExplicit = false;
    return setExportContainerState(value);
  };
  const applyChosenContainer = (ids: readonly string[], value: ExportContainer) => {
    if (!ids.length) return false;
    const selectedIds = new Set(ids);
    let changed = false;
    deps.setProjectItems((items) => {
      if (!items.some((item) => selectedIds.has(item.id) && item.exportOptions.container !== value))
        return items;
      changed = true;
      return items.map((item) =>
        selectedIds.has(item.id)
          ? { ...item, exportOptions: { ...item.exportOptions, container: value } }
          : item,
      );
    });
    if (changed) {
      deps.markDirty();
      deps.setDirty(true);
    }
    return changed;
  };
  const chooseExportScope = (value: ExportScope) => {
    setExportScope(value);
    if (containerChoiceExplicit) applyChosenContainer(exportItemIDs(), exportContainer());
  };
  const chooseExportItems: Setter<string[]> = (value) => {
    const ids = setSelectedExportItems(value);
    if (exportScope() === "selected" && containerChoiceExplicit)
      applyChosenContainer(ids, exportContainer());
    return ids;
  };
  const [streamIndexes, setStreamIndexes] = createSignal<number[]>([]);
  const destinationsAtom = Atom.make<Destination[]>([]);
  const destinationCapabilitiesAtom = Atom.make<components["schemas"]["DestinationCapabilities"]>({
    saveBesideSource: false,
  });
  const destinations = useAtomValue(() => destinationsAtom);
  const destinationCapabilities = useAtomValue(() => destinationCapabilitiesAtom);
  const setDestinations = (value: Destination[]) => registry.set(destinationsAtom, value);
  const setDestinationCapabilities = (value: components["schemas"]["DestinationCapabilities"]) =>
    registry.set(destinationCapabilitiesAtom, value);
  const [preflightError, setPreflightError] = createSignal("");
  const [destinationId, setDestinationId] = createSignal(lastDestinationId() ?? "download");
  const [destinationStatus, setDestinationStatus] = createSignal("");
  const [filenameTemplate, setFilenameTemplate] = createSignal(deps.settings().filenameTemplate);
  const [preflight, setPreflight] = createSignal<ExportPreflight>();
  const [preflightPending, setPreflightPending] = createSignal(false);
  const [exportPending, setExportPending] = createSignal(false);
  let workflowActive = false;
  let preflightVersion = 0;
  let workflowGeneration = 0;
  let workflowCommand: Atom.AtomResultFn<void, void, Error> | undefined;
  let cancellationGeneration = 0;
  const invalidatedTerminalJobs = new Set<string>();
  const [exportCancellation, setExportCancellation] = createSignal<ExportCancellation>();
  const [exportCancellationPending, setExportCancellationPending] = createSignal(false);
  const [pendingChildJobs, setPendingChildJobs] = createSignal<ReadonlySet<string>>(new Set());
  const pendingBatchCancellations = new Set<string>();
  let childJobContextGeneration = 0;
  const cancellationResponseIsStale = (
    kind: "batch" | "job",
    id: string,
    state: ExportJob["state"],
  ) => {
    const cancellation = exportCancellation();
    if (
      !cancellation ||
      (kind === "batch" ? cancellation.batchId !== id : cancellation.jobId !== id)
    )
      return false;
    return state === "queued" || state === "running";
  };
  const generatedMutation = <Arg, A, E>(
    atom: Atom.AtomResultFn<Arg, A, E>,
    argument: Arg,
  ): Effect.Effect<A, E> =>
    Effect.acquireUseRelease(
      Effect.sync(() => registry.mount(atom)),
      () => {
        registry.set(atom, argument);
        return AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
      },
      (release) =>
        Effect.sync(() => {
          registry.set(atom, Atom.Reset);
          release();
        }),
    );
  const generatedApi = deps.server.generatedApi;
  if (!generatedApi) throw new Error("Generated export API is not configured.");
  const preflightMutation = generatedApi.mutation("default", "preflightExport");
  const preflightRequest = (request: {
    projectId: string;
    input: components["schemas"]["ExportInput"];
  }) =>
    generatedMutation(preflightMutation, {
      params: { projectId: request.projectId },
      payload: request.input,
    });
  const preflightCommand = runtime.fn(
    (request: { projectId: string; input: components["schemas"]["ExportInput"] }) =>
      Effect.andThen(Effect.sleep(250), preflightRequest(request)),
  );
  const runPreflight = useAtomSet(() => preflightCommand, { mode: "promise" });
  const cancelPreflight = () => {
    registry.set(preflightCommand, Atom.Interrupt);
    preflightVersion++;
  };

  const batchListAtom = generatedApi.query("default", "listBatches", { query: { limit: 50 } });
  const batchList = useServerAtom(() => batchListAtom);
  const destinationAtom = generatedApi.query("default", "listDestinations", {});
  const destinationResult = useServerAtom(() => destinationAtom);
  const cancelBatchCommands = Atom.family((id: string) =>
    runtime.fn(() => {
      const cancel = deps.server.generatedApi?.mutation("default", "cancelBatch");
      return cancel
        ? generatedMutation(cancel, { params: { batchId: id } }).pipe(
            Effect.mapError(() => new Error("Export batch could not be cancelled.")),
          )
        : Effect.fail(new Error("Generated export API is not configured."));
    }),
  );
  const cancelChildCommands = Atom.family((id: string) =>
    runtime.fn(() => {
      const cancel = deps.server.generatedApi?.mutation("default", "cancelJob");
      return cancel
        ? generatedMutation(cancel, { params: { jobId: id } }).pipe(
            Effect.mapError(() => new Error("Export job could not be cancelled. Try again.")),
          )
        : Effect.fail(new Error("Generated export API is not configured."));
    }),
  );
  const uncertainRetries = new Map<string, { key: string; body: { jobId: string } }>();
  let uncertainExport:
    | {
        key: string;
        body: components["schemas"]["ExportSubmissionInput"];
      }
    | undefined;
  const isUncertainCommandFailure = (error: unknown): boolean => {
    if (!error || typeof error !== "object") return true;
    if ("status" in error && typeof error.status === "number") return error.status >= 500;
    if ("error" in error && error.error && typeof error.error === "object") {
      const envelope = error.error;
      if ("code" in envelope && typeof envelope.code === "string")
        return envelope.code === "internal_error";
    }
    if ("code" in error && typeof error.code === "string") return error.code === "internal_error";
    if ("reason" in error && error.reason && typeof error.reason === "object") {
      const reason = error.reason;
      if ("response" in reason && reason.response && typeof reason.response === "object") {
        const response = reason.response;
        if ("status" in response && typeof response.status === "number")
          return response.status >= 500;
      }
    }
    return true;
  };
  const refreshBatches = () => registry.refresh(batchListAtom);
  const refreshQueue = () => refreshBatches();
  const markChildJobPending = (id: string, pending: boolean) => {
    setPendingChildJobs((current) => {
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const beginChildJobAction = (id: string) => {
    if (pendingChildJobs().has(id)) return false;
    markChildJobPending(id, true);
    return true;
  };
  const childJobActionIsCurrent = (id: string, context: ChildJobContext) =>
    pendingChildJobs().has(id) &&
    context.generation === childJobContextGeneration &&
    context.projectId === deps.projectId() &&
    context.mediaId === deps.selected()?.id &&
    context.revision === deps.revision() &&
    context.editorVersion === deps.editorVersion();
  const activeExportContextIsCurrent = (id: string, context: ChildJobContext) =>
    childJobActionIsCurrent(id, context) &&
    context.batchId === batchId() &&
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
  createEffect(() => {
    const page = batchList.value();
    if (!page) return;
    const snapshots: ObservedBatch[] = [];
    const entries = Array.isArray(page.items) ? page.items : [];
    for (const entry of entries) {
      try {
        const snapshot = Schema.decodeUnknownSync(BatchSchema)(entry);
        observeBatchSnapshot(snapshot.batchId, snapshot);
        snapshots.push(snapshot);
      } catch {
        // Ignore malformed page entries rather than seeding an owner atom from unvalidated data.
      }
    }
    const ids = snapshots.map((snapshot) => snapshot.batchId);
    const activeID = untrack(batchId);
    const retained = activeID && !ids.includes(activeID) ? [activeID] : [];
    setBatchIDs([...new Set([...retained, ...ids])]);
    if (!activeID) {
      const active = snapshots.find((snapshot) => {
        const result = untrack(() => batchSnapshot(snapshot.batchId));
        if (!AsyncResult.isSuccess(result)) return false;
        // SAFETY: ServerState decoded this owner snapshot with BatchSchema before publishing it.
        return isBatchActive(result.value as unknown as Batch);
      });
      if (active) setBatchId(active.batchId);
    }
  });
  createEffect(() => {
    const result = currentBatchResult();
    if (!AsyncResult.isSuccess(result)) return;
    const next = result.value;
    if (
      next.batchId !== batchId() ||
      cancellationResponseIsStale("batch", next.batchId, next.state)
    )
      return;
    // SAFETY: ServerState decoded this owner snapshot with BatchSchema before publishing it.
    const displayed = projectCancellation(next as unknown as Batch);
    if (displayed.state === "queued") setExportStatus("Export queued.");
    else if (displayed.state === "running")
      setExportStatus(`Export batch running (${Math.round(displayed.progress * 100)}%).`);
    else if (displayed.state === "succeeded") setExportStatus("Export complete.");
    else if (displayed.state === "cancelled") setExportStatus("Export cancelled.");
    else {
      const failedJob = displayed.jobs.find((job) => job.state === "failed");
      setExportStatus(
        failedJob ? exportFailureMessage(failedJob.errorCode) : "Export batch failed.",
      );
    }
    const newTerminalJobs = next.jobs.filter(
      (job) =>
        ["succeeded", "failed", "cancelled"].includes(job.state) &&
        !invalidatedTerminalJobs.has(job.id),
    );
    if (newTerminalJobs.length) {
      for (const job of newTerminalJobs) invalidatedTerminalJobs.add(job.id);
      deps.server.refreshMedia();
      refreshBatches();
    }
  });
  createEffect(() => {
    const value = destinationResult.value();
    if (!value) return;
    const configured = Array.isArray(value.destinations) ? value.destinations : [];
    setDestinations(configured);
    setDestinationCapabilities(
      value.capabilities ?? {
        saveBesideSource: configured.some((item) => item.kind === "source_adjacent"),
      },
    );
  });
  createEffect(() => {
    const configured = destinations().filter(
      (destination) =>
        destination.kind !== "source_adjacent" || destinationCapabilities().saveBesideSource,
    );
    const current = destinationId();
    if (!configured.length) return;
    if (!destinationIsConfigured(current, configured)) {
      const fallback = configured[0];
      setDestinationId(fallback.id);
      rememberDestination(fallback.id);
      setDestinationStatus("Remembered destination is unavailable. Using " + fallback.label + ".");
      return;
    }
    rememberDestination(current);
  });
  createEffect(() => {
    const item = deps.selected();
    const currentProjectID = deps.projectId();
    const mode = exportMode();
    const selection = exportSelection();
    const strategy = cutStrategy();
    const indexes = streamIndexes();
    deps.revision();
    const destination = destinationId();
    const template = filenameTemplate();
    const preflightItemIDs = exportItemIDs();
    const currentItem = deps.projectItems().find((entry) => entry.media.id === item?.id);
    if (!item || !currentItem || preflightItemIDs.length === 0) {
      cancelPreflight();
      setPreflight();
      setPreflightError("");
      setPreflightPending(false);
      return;
    }
    deps.tracks();
    if (workflowActive || deps.dirty()) {
      cancelPreflight();
      setPreflight();
      setPreflightError("");
      if (!workflowActive) setPreflightPending(false);
      return;
    }
    const input = {
      mode,
      selection,
      streamIndexes: indexes,
      cutStrategy: strategy,
      container: exportContainer(),
      destinationId: destination,
      filenameTemplate: template,
      itemIds: [...preflightItemIDs],
    };
    cancelPreflight();
    setPreflightPending(true);
    const version = preflightVersion;
    void runPreflight({ projectId: currentProjectID, input })
      .then(
        (fresh) => {
          if (version !== preflightVersion) return;
          setPreflight(fresh);
          setPreflightError("");
        },
        (error: unknown) => {
          if (version !== preflightVersion) return;
          setPreflight();
          setPreflightError(preflightFailureMessage(error));
          setExportStatus("Export preflight failed. Try again.");
        },
      )
      .finally(() => {
        if (version === preflightVersion) setPreflightPending(false);
      });
  });

  const clearExportContext = () => {
    workflowGeneration++;
    cancellationGeneration++;
    if (workflowCommand) registry.set(workflowCommand, Atom.Interrupt);
    workflowCommand = undefined;
    workflowActive = false;
    setExportPending(false);
    cancelPreflight();
    const cancelling = exportCancellation()?.batchId;
    if (cancelling) registry.set(cancelBatchCommands(cancelling), Atom.Interrupt);
    childJobContextGeneration++;
    for (const id of pendingBatchCancellations) {
      registry.set(cancelBatchCommands(id), Atom.Interrupt);
    }
    pendingBatchCancellations.clear();
    for (const id of pendingChildJobs()) {
      registry.set(cancelChildCommands(id), Atom.Interrupt);
    }
    setPendingChildJobs(new Set<string>());
    setExportCancellation();
    setExportCancellationPending(false);
    setBatchId(undefined);
    setExportStatus("");
  };
  const exportProject = async () => {
    const cancellationPending = exportCancellationPending();
    if (
      exportPending() ||
      (!cancellationPending &&
        (isJobActive(exportJob()) ||
          batchJobs().some(isJobActive) ||
          (batchId() &&
            batches()
              .find((batch) => batch.batchId === batchId())
              ?.jobs.some(isJobActive))))
    )
      return;
    if (cancellationPending) {
      cancellationGeneration++;
      const id = exportCancellation()?.batchId;
      if (id) registry.set(cancelBatchCommands(id), Atom.Interrupt);
      setExportCancellation();
      setExportCancellationPending(false);
    }
    const itemIDs = [...exportItemIDs()];
    const items = deps.editableItems();
    if (!itemIDs.length) return void setExportStatus("Select at least one project item.");
    const selectedItems = items.filter((item) => itemIDs.includes(item.id));
    const selection = exportSelection();
    if (
      selectedItems.length !== itemIDs.length ||
      (selection === "segments" &&
        selectedItems.some(
          (item) => !item.timeline.present.segments.some((segment) => segment.included !== false),
        ))
    )
      return void setExportStatus(
        selection === "gaps"
          ? "Select a project item before creating gap exports."
          : "Add or include a segment in each selected project item before creating clips.",
      );

    workflowActive = true;
    const generation = ++workflowGeneration;
    const context = {
      projectId: deps.projectId(),
      mediaId: deps.selected()?.id,
      editorVersion: deps.editorVersion(),
      revision: deps.revision(),
      scope: exportScope(),
      itemIDs,
      input: {
        mode: exportMode(),
        selection: exportSelection(),
        streamIndexes: [...streamIndexes()],
        cutStrategy: cutStrategy(),
        container: exportContainer(),
        destinationId: destinationId(),
        filenameTemplate: filenameTemplate(),
        itemIds:
          itemIDs.length === items.length &&
          itemIDs.every((id) => items.some((item) => item.id === id))
            ? undefined
            : itemIDs,
      },
    };
    let expectedRevision = context.revision;
    const editorContextCurrent = () =>
      context.projectId === deps.projectId() &&
      expectedRevision === deps.revision() &&
      context.mediaId === deps.selected()?.id &&
      context.editorVersion === deps.editorVersion() &&
      context.scope === exportScope() &&
      context.itemIDs.length === exportItemIDs().length &&
      context.itemIDs.every((id, index) => exportItemIDs()[index] === id);
    const workflowCurrent = () => generation === workflowGeneration && editorContextCurrent();
    const stopForStaleContext = () => {
      if (generation === workflowGeneration)
        setExportStatus("Create clips stopped because the project changed. Save again and retry.");
    };
    let savedRevision = context.revision;
    cancelPreflight();
    setPreflight();
    setPreflightError("");
    setPreflightPending(true);
    setExportPending(true);
    setExportStatus(deps.dirty() ? "Saving project…" : "Checking export requirements…");
    const command = runtime.fn(() =>
      Effect.gen(function* () {
        if (deps.dirty()) {
          const saved = yield* Effect.tryPromise({
            try: () => deps.saveProject(),
            catch: (error) =>
              error instanceof Error ? error : new Error("Project could not be saved."),
          });
          if (!saved) {
            if (workflowCurrent())
              setExportStatus(deps.status() || "Project could not be saved. Try again.");
            else stopForStaleContext();
            return;
          }
          expectedRevision = saved.revision;
          if (!workflowCurrent()) {
            stopForStaleContext();
            return;
          }
          savedRevision = saved.revision;
        }
        if (!workflowCurrent()) {
          stopForStaleContext();
          return;
        }
        setExportStatus("Checking export requirements…");
        const checked = yield* Effect.exit(
          preflightRequest({
            projectId: context.projectId,
            input: { ...context.input, itemIds: [...itemIDs] },
          }),
        );
        if (!workflowCurrent()) {
          stopForStaleContext();
          return;
        }
        if (Exit.isFailure(checked)) {
          const failure = Cause.squash(checked.cause);
          setPreflight();
          setPreflightError(preflightFailureMessage(failure));
          setExportStatus("Export preflight failed. Try again.");
          return;
        }
        const fresh = checked.value;
        setPreflight(fresh);
        setPreflightError("");
        if (!fresh.allowed) {
          setExportStatus("");
          return;
        }
        if (!workflowCurrent()) {
          stopForStaleContext();
          return;
        }
        setExportStatus("Creating clips…");
        const submissionBody: components["schemas"]["ExportSubmissionInput"] = {
          projectRevision: savedRevision,
          ...(context.input.itemIds ? { itemIds: context.input.itemIds } : {}),
        };
        const key = idempotencyKeyForAttempt(uncertainExport, submissionBody, () =>
          globalThis.crypto.randomUUID(),
        );
        const create = deps.server.generatedApi?.mutation("default", "createExport");
        const response = yield* Effect.exit(
          create
            ? generatedMutation(create, {
                params: { projectId: context.projectId },
                headers: { "Idempotency-Key": key },
                payload: submissionBody,
              }).pipe(
                Effect.mapError((error) => {
                  uncertainExport = isUncertainCommandFailure(error)
                    ? { key, body: submissionBody }
                    : undefined;
                  return error instanceof Error ? error : new Error("Export request failed.");
                }),
              )
            : Effect.fail(new Error("Generated export API is not configured.")),
        );
        if (Exit.isFailure(response)) {
          const failure = Cause.squash(response.cause);
          if (failure instanceof ApiFailure) {
            setExportStatus(
              failure.code === "export_busy"
                ? "Export capacity is busy. Try again shortly."
                : "Export could not be started. Try again.",
            );
            return;
          }
          yield* Effect.fail(
            failure instanceof Error ? failure : new Error("Export could not be started."),
          );
          return;
        }
        const submission = parseBatchExportSubmission(response.value);
        uncertainExport = undefined;
        if (!workflowCurrent()) {
          stopForStaleContext();
          return;
        }
        const initialBatch = Schema.decodeUnknownSync(BatchSchema)({
          batchId: submission.batchId,
          projectId: context.projectId,
          projectRevision: savedRevision,
          state: "queued",
          progress: 0,
          jobs: submission.jobs,
        });
        observeBatchSnapshot(initialBatch.batchId, initialBatch);
        setBatchIDs((ids) => [
          initialBatch.batchId,
          ...ids.filter((id) => id !== initialBatch.batchId),
        ]);
        setBatchId(initialBatch.batchId);
        refreshBatches();
        const job = selectBatchJob(submission.jobs);
        setExportStatus(
          job?.state === "queued"
            ? "Export queued."
            : job?.state === "running"
              ? "Export running."
              : "Export complete.",
        );
      }),
    );
    workflowCommand = command;
    registry.set(command, undefined);
    try {
      await runEffect(readServerAtom(deps.server, command));
    } catch (error) {
      if (workflowCurrent())
        setExportStatus(
          error instanceof Error ? error.message : "Export could not be started. Try again.",
        );
    } finally {
      if (workflowCommand === command) {
        workflowActive = false;
        workflowCommand = undefined;
        setExportPending(false);
        setPreflightPending(false);
      }
    }
  };
  const cancelExport = async () => {
    const currentBatchId = batchId();
    const currentBatch = batches().find((batch) => batch.batchId === currentBatchId);
    const job = [...batchJobs(), ...(currentBatch?.jobs ?? [])].find(isJobActive) ?? exportJob();
    if (!job || !currentBatchId || !isJobActive(job) || exportCancellationPending()) return;
    const generation = ++cancellationGeneration;
    markLocallyCancelledBatch(currentBatchId, true);
    deps.server.setBatchLocallyCancelled(currentBatchId, true);
    const command = cancelBatchCommands(currentBatchId);
    registry.set(command, undefined);
    setExportCancellationPending(true);
    setExportCancellation({ batchId: currentBatchId, jobId: job.id });
    setExportStatus("Export batch cancellation requested.");
    try {
      await runEffect(readServerAtom(deps.server, command));
      if (generation !== cancellationGeneration) return;
      markLocallyCancelledBatch(currentBatchId, true);
      setExportStatus("Export batch cancellation requested.");
      refreshQueue();
    } catch (error) {
      markLocallyCancelledBatch(currentBatchId, false);
      deps.server.setBatchLocallyCancelled(currentBatchId, false);
      if (generation === cancellationGeneration) {
        setExportCancellation();
        refreshQueue();
        setExportStatus(
          error instanceof Error ? error.message : "Export could not be cancelled. Try again.",
        );
      }
    } finally {
      if (generation === cancellationGeneration) setExportCancellationPending(false);
    }
  };
  const cancelBatch = async (id: string) => {
    const currentBatch = batches().find((batch) => batch.batchId === id);
    if (
      id === batchId() &&
      (batchJobs().some(isJobActive) ||
        currentBatch?.jobs.some(isJobActive) ||
        isJobActive(exportJob()))
    )
      return cancelExport();
    if (pendingBatchCancellations.has(id)) return;
    pendingBatchCancellations.add(id);
    const generation = childJobContextGeneration;
    markLocallyCancelledBatch(id, true);
    deps.server.setBatchLocallyCancelled(id, true);
    try {
      const command = cancelBatchCommands(id);
      registry.set(command, undefined);
      await runEffect(readServerAtom(deps.server, command));
      if (generation !== childJobContextGeneration) return;
      markLocallyCancelledBatch(id, true);
    } catch (error) {
      markLocallyCancelledBatch(id, false);
      deps.server.setBatchLocallyCancelled(id, false);
      if (generation === childJobContextGeneration)
        setExportStatus(
          error instanceof Error ? error.message : "Export batch could not be cancelled.",
        );
    } finally {
      if (generation === childJobContextGeneration) {
        pendingBatchCancellations.delete(id);
        refreshQueue();
      }
    }
  };
  const currentBatchError = () => {
    const result = currentBatchResult();
    if (!AsyncResult.isFailure(result)) return "";
    const cause = Cause.squash(result.cause);
    return requestErrorMessage(cause, "Request could not be completed.");
  };
  const childJobContext = (): ChildJobContext => ({
    projectId: deps.projectId(),
    mediaId: deps.selected()?.id,
    revision: deps.revision(),
    batchId: batchId(),
    exportJobId: exportJob()?.id,
    editorVersion: deps.editorVersion(),
    generation: childJobContextGeneration,
  });
  const cancelChildJob = async (id: string, _requestedBatchId?: string) => {
    if (!beginChildJobAction(id)) return;
    const context = childJobContext();
    markLocallyCancelledJob(id, true);
    deps.server.setJobLocallyCancelled(id, true);
    try {
      const command = cancelChildCommands(id);
      registry.set(command, undefined);
      await runEffect(readServerAtom(deps.server, command));
      if (!childJobActionIsCurrent(id, context)) return;
      markLocallyCancelledJob(id, true);
      setExportStatus("Export job cancellation requested.");
    } catch (error) {
      markLocallyCancelledJob(id, false);
      deps.server.setJobLocallyCancelled(id, false);
      if (childJobActionIsCurrent(id, context))
        setExportStatus(
          error instanceof Error ? error.message : "Export job could not be cancelled. Try again.",
        );
    } finally {
      if (childJobActionIsCurrent(id, context)) refreshQueue();
      if (context.generation === childJobContextGeneration) markChildJobPending(id, false);
    }
  };
  const retryChildJob = async (id: string, requestedBatchId?: string) => {
    if (!beginChildJobAction(id)) return;
    const jobBatchId = childJobBatchId(id, requestedBatchId);
    const context = childJobContext();
    try {
      const body = { jobId: id };
      const key = idempotencyKeyForAttempt(uncertainRetries.get(id), body, () =>
        globalThis.crypto.randomUUID(),
      );
      const retry = deps.server.generatedApi?.mutation("default", "retryJob");
      if (!retry) throw new Error("Generated export API is not configured.");
      const result = await runEffect(
        generatedMutation(retry, {
          params: { jobId: id },
          headers: { "Idempotency-Key": key },
        }).pipe(
          Effect.mapError((error) => {
            if (isUncertainCommandFailure(error)) uncertainRetries.set(id, { key, body });
            else uncertainRetries.delete(id);
            return error instanceof Error ? error : new Error("Export retry failed.");
          }),
        ),
      );
      const validatedBatch = Schema.decodeUnknownSync(BatchSchema)(result);
      uncertainRetries.delete(id);
      observeBatchSnapshot(validatedBatch.batchId, validatedBatch);
      if (!childJobActionIsCurrent(id, context)) return;
      setBatchIDs((ids) => [
        validatedBatch.batchId,
        ...ids.filter((batchID) => batchID !== validatedBatch.batchId),
      ]);
      const updatesActiveContext =
        activeExportContextIsCurrent(id, context) &&
        (jobBatchId === context.batchId || context.exportJobId === id);
      if (updatesActiveContext) {
        setBatchId(validatedBatch.batchId);
      }
      setExportStatus("Export retry queued as a new job.");
    } catch (error) {
      if (childJobActionIsCurrent(id, context))
        setExportStatus(
          error instanceof Error ? error.message : "Export job could not be retried. Try again.",
        );
    } finally {
      if (childJobActionIsCurrent(id, context)) refreshQueue();
      if (context.generation === childJobContextGeneration) markChildJobPending(id, false);
    }
  };
  onCleanup(() => {
    clearExportContext();
    for (const unsubscribe of batchSnapshotUnsubscribers) unsubscribe();
  });
  return {
    selectedExportItems,
    setSelectedExportItems,
    chooseExportItems,
    chooseExportScope,
    exportScope,
    exportItemIDs,
    batches,
    exportJob,
    batchJobs,
    batchId,
    exportRevision,
    exportStatus,
    exportMode,
    setExportMode,
    exportSelection,
    setExportSelection,
    cutStrategy,
    setCutStrategy,
    exportContainer,
    setExportContainer,
    streamIndexes,
    setStreamIndexes,
    destinations,
    destinationCapabilities,
    destinationId,
    setDestinationId,
    filenameTemplate,
    setFilenameTemplate,
    preflight,
    preflightPending,
    preflightError,
    exportPending,
    exportCancellationPending,
    childJobPending: (id: string) => pendingChildJobs().has(id),
    destinationsLoading: () => destinationResult.waiting(),
    destinationsError: () =>
      requestErrorMessage(destinationResult.error(), "Request could not be completed."),
    retryDestinations: () => registry.refresh(destinationAtom),
    batchesLoading: () => batchList.waiting() && !batchList.value(),
    batchesRefreshing: () => batchList.waiting(),
    batchesError: () => requestErrorMessage(batchList.error(), "Request could not be completed."),
    refreshBatches,
    batchLoading: () => Boolean(batchId()) && currentBatchResult().waiting,
    batchError: currentBatchError,
    exportJobLoading: () => Boolean(exportJob()?.id) && currentBatchResult().waiting,
    exportJobError: currentBatchError,
    destinationStatus,
    clearExportContext,
    exportProject,
    cancelExport,
    cancelBatch,
    cancelChildJob,
    retryChildJob,
    setMode: (value: "merge" | "separate") => {
      setExportMode(value);
      deps.markDirty();
      deps.setDirty(true);
    },
    setSelection: (value: "segments" | "gaps") => {
      setExportSelection(value);
      deps.markDirty();
      deps.setDirty(true);
    },
    setStrategy: (value: AppSettings["cutStrategy"]) => {
      setCutStrategy(value);
      deps.saveSettings({ cutStrategy: value });
      deps.markDirty();
      deps.setDirty(true);
    },
    setContainer: (value: ExportContainer) => {
      containerChoiceExplicit = true;
      setExportContainerState(value);
      if (!applyChosenContainer(exportItemIDs(), value)) {
        deps.markDirty();
        deps.setDirty(true);
      }
    },
    setDestination: (value: string) => {
      setDestinationId(value);
      if (destinationIsConfigured(value, destinations())) {
        rememberDestination(value);
        setDestinationStatus("");
      }
      deps.markDirty();
      deps.setDirty(true);
    },
    setItemDestination: (id: string, value: string) => {
      deps.setProjectItems((items) =>
        items.map((item) =>
          item.id === id
            ? { ...item, exportOptions: { ...item.exportOptions, destinationId: value } }
            : item,
        ),
      );
      if (id === deps.activeItemId()) setDestinationId(value);
      deps.markDirty();
      deps.setDirty(true);
    },
    setTemplate: (value: string) => {
      if (!validFilenameTemplateLength(value)) return false;
      setFilenameTemplate(value);
      deps.saveSettings({ filenameTemplate: value });
      deps.markDirty();
      deps.setDirty(true);
      return true;
    },
    setStreams: (value: number[]) => {
      setStreamIndexes(value);
      deps.markDirty();
      deps.setDirty(true);
    },
  };
}
