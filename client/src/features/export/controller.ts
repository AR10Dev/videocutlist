import { createEffect, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import { useQuery, type QueryClient } from "@tanstack/solid-query";
import { readApiError, type ApiClient } from "../../api";
import type { components } from "../../generated/api";
import type { EditableProjectItem, ExportContainer } from "../projects/model";
import type { Segment } from "../preview/model";
import type { AppSettings } from "../settings/model";
import { abortAndClear, cancellationIsCurrent } from "../queue/cancellation";
import { exportFailureMessage } from "../queue/jobUi";
import { jobPollInterval } from "../queue/jobPolling";
import {
  isBatchActive,
  isJobActive,
  parseBatchExportSubmission,
  selectBatchJob,
} from "./queueResponse";
import { destinationIsConfigured, lastDestinationId, rememberDestination } from "./destination";

type Media = components["schemas"]["Media"];
type Destination = components["schemas"]["Destination"];
type ExportJob = components["schemas"]["Job"];
type Batch = components["schemas"]["Batch"];
type QuerySnapshot<T> = {
  value: T;
  generation: number;
};
type ExportCancellation = {
  batchId: string;
  jobId: string;
  phase: "requested" | "confirmed";
  generation: number;
};
type ChildJobAction = {
  token: number;
  controller: AbortController;
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
type DestinationResponse = {
  destinations?: Destination[];
  capabilities?: components["schemas"]["DestinationCapabilities"];
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
  queryClient: QueryClient;
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
  const [batches, setBatches] = createSignal<Batch[]>([]);
  const [exportJob, setExportJob] = createSignal<ExportJob>();
  const [batchJobs, setBatchJobs] = createSignal<ExportJob[]>([]);
  const [batchId, setBatchId] = createSignal<string>();
  const [exportRevision, setExportRevision] = createSignal<number>();
  const [exportStatus, setExportStatus] = createSignal("");
  const [exportMode, setExportMode] = createSignal<"merge" | "separate">("merge");
  const [exportSelection, setExportSelection] = createSignal<"segments" | "gaps">("segments");
  const [cutStrategy, setCutStrategy] = createSignal(deps.settings().cutStrategy);
  const [exportContainer, setExportContainer] = createSignal<ExportContainer>("mkv");
  const [streamIndexes, setStreamIndexes] = createSignal<number[]>([]);
  const [destinations, setDestinations] = createSignal<Destination[]>([]);
  const [destinationCapabilities, setDestinationCapabilities] = createSignal<
    components["schemas"]["DestinationCapabilities"]
  >({ saveBesideSource: false });
  const [preflightError, setPreflightError] = createSignal("");
  const [destinationId, setDestinationId] = createSignal(lastDestinationId() ?? "download");
  const [destinationStatus, setDestinationStatus] = createSignal("");
  const [filenameTemplate, setFilenameTemplate] = createSignal(deps.settings().filenameTemplate);
  const [preflight, setPreflight] = createSignal<components["schemas"]["ExportPreflight"]>();
  const [preflightPending, setPreflightPending] = createSignal(false);
  const [exportPending, setExportPending] = createSignal(false);
  let exportTimer: number | undefined;
  let exportRequest = 0;
  let workflowRequest = 0;
  let workflowActive = false;
  let preflightVersion = 0;
  let preflightController: AbortController | undefined;
  let workflowController: AbortController | undefined;
  let exportController: AbortController | undefined;
  let exportCancellationController: AbortController | undefined;
  const invalidatedTerminalJobs = new Set<string>();
  const [queryGeneration, setQueryGeneration] = createSignal(0);
  const [exportCancellation, setExportCancellation] = createSignal<ExportCancellation>();
  const [exportCancellationPending, setExportCancellationPending] = createSignal(false);
  const [pendingChildJobs, setPendingChildJobs] = createSignal<ReadonlySet<string>>(new Set());
  const childJobActions = new Map<string, ChildJobAction>();
  let childJobContextGeneration = 0;
  let nextChildJobActionToken = 0;
  let nextQueryGeneration = 0;
  const cancellationResponseIsStale = (
    kind: "batch" | "job",
    id: string,
    state: ExportJob["state"],
    generation: number,
  ) => {
    const cancellation = exportCancellation();
    if (
      !cancellation ||
      (kind === "batch" ? cancellation.batchId !== id : cancellation.jobId !== id)
    )
      return false;
    if (cancellation.phase === "requested") return state === "queued" || state === "running";
    return generation < cancellation.generation;
  };
  const cancelPreflight = () => {
    preflightController?.abort();
    preflightController = undefined;
    if (exportTimer) window.clearTimeout(exportTimer);
    exportTimer = undefined;
    preflightVersion++;
  };

  const batchProgressQuery = useBatchQuery(deps.api, batchId, queryGeneration);
  const batchListQuery = useBatchListQuery(deps.api);
  const exportStatusQuery = useExportJobQuery(deps.api, exportJob, queryGeneration);
  const destinationsQuery = useDestinationsQuery(deps.api);
  const reconcileBatchQueries = async (id: string, jobs: readonly ExportJob[]) => {
    const jobIds = [...new Set(jobs.map((job) => job.id))];
    await Promise.all([
      deps.queryClient.invalidateQueries({ queryKey: ["batches"] }),
      deps.queryClient.invalidateQueries({ queryKey: ["batch", id] }),
      ...jobIds.map((jobId) =>
        deps.queryClient.invalidateQueries({ queryKey: ["job", "export", jobId] }),
      ),
    ]);
    await Promise.all([
      deps.queryClient.refetchQueries({ queryKey: ["batches"], type: "active" }),
      deps.queryClient.refetchQueries({ queryKey: ["batch", id], type: "active" }),
      ...jobIds.map((jobId) =>
        deps.queryClient.refetchQueries({
          queryKey: ["job", "export", jobId],
          type: "active",
        }),
      ),
    ]);
  };
  const markChildJobPending = (id: string, pending: boolean) => {
    setPendingChildJobs((current) => {
      const next = new Set(current);
      if (pending) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const beginChildJobAction = (id: string) => {
    if (childJobActions.has(id)) return;
    const action: ChildJobAction = {
      token: ++nextChildJobActionToken,
      controller: new AbortController(),
    };
    childJobActions.set(id, action);
    markChildJobPending(id, true);
    return action;
  };
  const finishChildJobAction = (id: string, action: ChildJobAction) => {
    if (childJobActions.get(id) !== action) return;
    childJobActions.delete(id);
    markChildJobPending(id, false);
  };
  const childJobActionIsCurrent = (id: string, action: ChildJobAction, context: ChildJobContext) =>
    childJobActions.get(id)?.token === action.token &&
    context.generation === childJobContextGeneration &&
    context.projectId === deps.projectId() &&
    context.mediaId === deps.selected()?.id &&
    context.revision === deps.revision() &&
    context.editorVersion === deps.editorVersion();
  const activeExportContextIsCurrent = (
    id: string,
    action: ChildJobAction,
    context: ChildJobContext,
  ) =>
    childJobActionIsCurrent(id, action, context) &&
    context.batchId === batchId() &&
    (exportJob()?.id === undefined || exportJob()?.id === (context.exportJobId ?? id));
  const childJobDetails = (id: string, requestedBatchId?: string) => {
    const activeBatchID = batchId();
    const activeJobs = batchJobs();
    const activeJob =
      requestedBatchId === undefined || requestedBatchId === activeBatchID
        ? activeJobs.find((job) => job.id === id)
        : undefined;
    const listedBatch =
      (requestedBatchId
        ? batches().find((batch) => batch.batchId === requestedBatchId)
        : batches().find((batch) => batch.jobs.some((job) => job.id === id))) ?? undefined;
    const currentExportJob = exportJob();
    const job =
      listedBatch?.jobs.find((item) => item.id === id) ??
      activeJob ??
      (currentExportJob?.id === id ? currentExportJob : undefined);
    const resolvedBatchID =
      listedBatch?.batchId ??
      requestedBatchId ??
      activeJob?.batchId ??
      (currentExportJob?.id === id ? activeBatchID : undefined);
    const jobs =
      listedBatch?.jobs ?? (resolvedBatchID === activeBatchID ? activeJobs : job ? [job] : []);
    return {
      batchId: resolvedBatchID,
      jobIds: [...new Set([id, ...jobs.map((item) => item.id)])],
    };
  };
  const childJobQueryKeys = (
    jobIds: readonly string[],
    batchIds: readonly (string | undefined)[],
  ) => {
    const uniqueJobIDs = [...new Set(jobIds)];
    const uniqueBatchIDs = [...new Set(batchIds.filter((id): id is string => Boolean(id)))];
    return [
      ["batches"] as const,
      ...uniqueBatchIDs.map((id) => ["batch", id] as const),
      ...uniqueJobIDs.map((id) => ["job", "export", id] as const),
    ];
  };
  const cancelChildJobQueries = async (
    jobIds: readonly string[],
    batchIds: readonly (string | undefined)[],
  ) => {
    const queryKeys = childJobQueryKeys(jobIds, batchIds);
    await Promise.allSettled(
      queryKeys.map((queryKey) => deps.queryClient.cancelQueries({ queryKey })),
    );
  };
  const reconcileChildJobQueries = async (
    jobIds: readonly string[],
    batchIds: readonly (string | undefined)[],
  ) => {
    const queryKeys = childJobQueryKeys(jobIds, batchIds);
    await Promise.allSettled(
      queryKeys.map((queryKey) => deps.queryClient.invalidateQueries({ queryKey })),
    );
    await Promise.allSettled(
      queryKeys.map((queryKey) => deps.queryClient.refetchQueries({ queryKey, type: "active" })),
    );
  };
  createEffect(() => {
    const page = batchListQuery.data;
    if (!page) return;
    const items = Array.isArray(page.items)
      ? page.items.filter(
          (batch): batch is Batch =>
            typeof batch?.batchId === "string" && Array.isArray(batch.jobs),
        )
      : [];
    setBatches(items);
    if (!batchId()) {
      const active = items.find(isBatchActive);
      if (active) setBatchId(active.batchId);
    }
  });
  createEffect(() => {
    const snapshot = batchProgressQuery.data;
    if (!snapshot) return;
    const next = snapshot.value;
    if (
      next.batchId !== batchId() ||
      cancellationResponseIsStale("batch", next.batchId, next.state, snapshot.generation)
    )
      return;
    setBatchJobs(next.jobs);
    setExportRevision(next.projectRevision);
    setExportJob(selectBatchJob(next.jobs));
    setBatches((items) => [next, ...items.filter((batch) => batch.batchId !== next.batchId)]);
    if (next.state === "queued") setExportStatus("Export batch queued.");
    else if (next.state === "running")
      setExportStatus(`Export batch running (${Math.round(next.progress * 100)}%).`);
    else if (next.state === "succeeded") setExportStatus("Export batch complete.");
    else if (next.state === "cancelled") setExportStatus("Export batch cancelled.");
    else if (next.state === "failed") setExportStatus("Export batch failed.");
  });
  createEffect(() => {
    const snapshot = exportStatusQuery.data;
    if (!snapshot) return;
    const next = snapshot.value;
    if (
      next.id !== exportJob()?.id ||
      cancellationResponseIsStale("job", next.id, next.state, snapshot.generation)
    )
      return;
    setExportJob(next);
    setExportStatus(
      next.state === "queued"
        ? "Export queued."
        : next.state === "running"
          ? "Export running."
          : next.state === "succeeded"
            ? "Export complete."
            : next.state === "cancelled"
              ? "Export cancelled."
              : exportFailureMessage(next.errorCode),
    );
    if (
      ["succeeded", "failed", "cancelled"].includes(next.state) &&
      !invalidatedTerminalJobs.has(next.id)
    ) {
      invalidatedTerminalJobs.add(next.id);
      void deps.queryClient.invalidateQueries({ queryKey: ["job", "export", next.id] });
      void deps.queryClient.invalidateQueries({ queryKey: ["project", deps.projectId()] });
      void deps.queryClient.invalidateQueries({ queryKey: ["media"] });
    }
  });
  createEffect(() => {
    const value = destinationsQuery.data;
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
    const controller = new AbortController();
    preflightController = controller;
    exportTimer = window.setTimeout(async () => {
      try {
        const response = await preflightRequest(
          deps.api,
          currentProjectID,
          input,
          controller.signal,
        );
        if (version !== preflightVersion) return;
        if (!response.ok) {
          setPreflight();
          setPreflightError(`Export preflight failed (${response.status}). Try again.`);
          setExportStatus("Export preflight failed. Try again.");
        } else {
          setPreflight((await response.json()) as components["schemas"]["ExportPreflight"]);
          setPreflightError("");
        }
      } catch {
        if (version === preflightVersion && !controller.signal.aborted) {
          setPreflight();
          setPreflightError("Export preflight could not be reached. Try again.");
          setExportStatus("Export preflight failed. Try again.");
        }
      }
      if (version === preflightVersion) {
        setPreflightPending(false);
        if (preflightController === controller) preflightController = undefined;
      }
    }, 250);
  });

  const clearExportContext = () => {
    workflowController?.abort();
    workflowController = undefined;
    workflowRequest++;
    workflowActive = false;
    setExportPending(false);
    cancelPreflight();
    exportController = abortAndClear(exportController);
    exportCancellationController = abortAndClear(exportCancellationController);
    childJobContextGeneration++;
    for (const action of childJobActions.values()) action.controller.abort();
    childJobActions.clear();
    setPendingChildJobs(new Set<string>());
    exportRequest++;
    setExportCancellation();
    setExportCancellationPending(false);
    setExportJob();
    setBatchJobs([]);
    setBatchId();
    setExportRevision();
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
      exportCancellationController?.abort();
      exportCancellationController = undefined;
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
    const request = ++workflowRequest;
    const submissionRequest = ++exportRequest;
    const controller = new AbortController();
    workflowController = controller;
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
    const editorContextCurrent = () =>
      context.projectId === deps.projectId() &&
      context.mediaId === deps.selected()?.id &&
      context.editorVersion === deps.editorVersion() &&
      context.scope === exportScope() &&
      context.itemIDs.length === exportItemIDs().length &&
      context.itemIDs.every((id, index) => exportItemIDs()[index] === id);
    const workflowCurrent = () =>
      request === workflowRequest &&
      submissionRequest === exportRequest &&
      !controller.signal.aborted &&
      editorContextCurrent();
    const stopForStaleContext = () => {
      if (request === workflowRequest && !controller.signal.aborted)
        setExportStatus("Create clips stopped because the project changed. Save again and retry.");
    };
    let savedRevision = context.revision;
    let submitted = false;
    cancelPreflight();
    setPreflight();
    setPreflightError("");
    setPreflightPending(true);
    setExportPending(true);
    setExportStatus(deps.dirty() ? "Saving project…" : "Checking export requirements…");
    try {
      if (deps.dirty()) {
        const saved = await deps.saveProject();
        if (!saved) {
          if (workflowCurrent())
            setExportStatus(deps.status() || "Project could not be saved. Try again.");
          else stopForStaleContext();
          return;
        }
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
      const preflightResponse = await preflightRequest(
        deps.api,
        context.projectId,
        { ...context.input, itemIds: [...itemIDs] },
        controller.signal,
      );
      if (!workflowCurrent()) {
        stopForStaleContext();
        return;
      }
      if (!preflightResponse.ok) {
        setPreflight();
        setPreflightError(`Export preflight failed (${preflightResponse.status}). Try again.`);
        setExportStatus("Export preflight failed. Try again.");
        return;
      }
      const fresh = (await preflightResponse.json()) as components["schemas"]["ExportPreflight"];
      if (!workflowCurrent()) {
        stopForStaleContext();
        return;
      }
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
      exportController = controller;
      const response = await deps.api.request(
        `projects/${encodeURIComponent(context.projectId)}/exports`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ itemIds: context.input.itemIds }),
          signal: controller.signal,
        },
      );
      if (!workflowCurrent()) {
        stopForStaleContext();
        return;
      }
      if (!response.ok) {
        const error = await readApiError(response);
        if (!workflowCurrent()) return;
        setExportStatus(
          error.code === "export_busy"
            ? "Export capacity is busy. Try again shortly."
            : "Export could not be started. Try again.",
        );
        return;
      }
      const submission = parseBatchExportSubmission(await response.json());
      if (!workflowCurrent()) {
        stopForStaleContext();
        return;
      }
      setBatchId(submission.batchId);
      setExportRevision(savedRevision);
      setBatchJobs(submission.jobs);
      setBatches((current) => [
        {
          batchId: submission.batchId,
          projectId: context.projectId,
          projectRevision: savedRevision,
          state: "queued",
          progress: 0,
          jobs: submission.jobs,
        },
        ...current.filter((batch) => batch.batchId !== submission.batchId),
      ]);
      void deps.queryClient.invalidateQueries({ queryKey: ["batches"] });
      const job = selectBatchJob(submission.jobs);
      if (job) setExportJob(job);
      setExportStatus(
        job?.state === "queued"
          ? "Export queued."
          : job?.state === "running"
            ? "Export running."
            : "Export complete.",
      );
      submitted = true;
    } catch (error) {
      if (!controller.signal.aborted && request === workflowRequest)
        setExportStatus(
          error instanceof Error ? error.message : "Export could not be started. Try again.",
        );
    } finally {
      if (request === workflowRequest) {
        workflowActive = false;
        workflowController = undefined;
        setExportPending(false);
        setPreflightPending(false);
        if (!submitted && exportController === controller) exportController = undefined;
      }
    }
  };
  const cancelExport = async () => {
    const currentBatchId = batchId();
    const currentBatch = batches().find((batch) => batch.batchId === currentBatchId);
    const jobs = [...batchJobs(), ...(currentBatch?.jobs ?? [])];
    const job = jobs.find(isJobActive) ?? exportJob();
    const jobsToReconcile = [...jobs, ...(job ? [job] : [])];
    if (!job || !currentBatchId || !isJobActive(job)) return;
    exportCancellationController?.abort();
    const controller = new AbortController();
    exportCancellationController = controller;
    setExportCancellationPending(true);
    const generation = ++nextQueryGeneration;
    setExportCancellation({
      batchId: currentBatchId,
      jobId: job.id,
      phase: "requested",
      generation,
    });
    setExportStatus("Export batch cancellation requested.");
    try {
      const jobIds = [...new Set(jobsToReconcile.map((item) => item.id))];
      await Promise.all([
        deps.queryClient.cancelQueries({ queryKey: ["batches"] }),
        deps.queryClient.cancelQueries({ queryKey: ["batch", currentBatchId] }),
        ...jobIds.map((jobId) =>
          deps.queryClient.cancelQueries({ queryKey: ["job", "export", jobId] }),
        ),
      ]);
      if (!cancellationIsCurrent(controller, exportCancellationController)) return;
      const response = await deps.api.request(`batches/${encodeURIComponent(currentBatchId)}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Export batch could not be cancelled.");
      if (!cancellationIsCurrent(controller, exportCancellationController)) return;
      setExportCancellation({
        batchId: currentBatchId,
        jobId: job.id,
        phase: "confirmed",
        generation,
      });
      setQueryGeneration(generation);
      exportController?.abort();
      exportController = undefined;
      setExportStatus("Export batch cancellation requested.");
      await reconcileBatchQueries(currentBatchId, jobsToReconcile);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        cancellationIsCurrent(controller, exportCancellationController)
      ) {
        setExportCancellation();
        await reconcileBatchQueries(currentBatchId, jobsToReconcile);
        if (cancellationIsCurrent(controller, exportCancellationController))
          setExportStatus(
            error instanceof Error ? error.message : "Export could not be cancelled. Try again.",
          );
      }
    } finally {
      if (exportCancellationController === controller) {
        exportCancellationController = undefined;
        setExportCancellationPending(false);
      }
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
    const jobs = currentBatch?.jobs ?? [];
    const jobIds = [...new Set(jobs.map((job) => job.id))];
    try {
      await Promise.all([
        deps.queryClient.cancelQueries({ queryKey: ["batches"] }),
        deps.queryClient.cancelQueries({ queryKey: ["batch", id] }),
        ...jobIds.map((jobId) =>
          deps.queryClient.cancelQueries({ queryKey: ["job", "export", jobId] }),
        ),
      ]);
      const response = await deps.api.request(`batches/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("Export batch could not be cancelled.");
      await reconcileBatchQueries(id, jobs);
    } catch (error) {
      await reconcileBatchQueries(id, jobs);
      setExportStatus(
        error instanceof Error ? error.message : "Export batch could not be cancelled.",
      );
    }
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
  const cancelChildJob = async (id: string, requestedBatchId?: string) => {
    const action = beginChildJobAction(id);
    if (!action) return;
    const details = childJobDetails(id, requestedBatchId);
    const context = childJobContext();
    try {
      await cancelChildJobQueries(details.jobIds, [details.batchId]);
      if (!childJobActionIsCurrent(id, action, context)) return;
      const response = await deps.api.request(`jobs/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: action.controller.signal,
      });
      if (!response.ok) {
        const error = await readApiError(response, "Export job could not be cancelled. Try again.");
        throw new Error(error.message);
      }
      if (childJobActionIsCurrent(id, action, context))
        setExportStatus("Export job cancellation requested.");
    } catch (error) {
      if (childJobActionIsCurrent(id, action, context))
        setExportStatus(
          error instanceof Error ? error.message : "Export job could not be cancelled. Try again.",
        );
    } finally {
      if (childJobActionIsCurrent(id, action, context))
        void reconcileChildJobQueries(details.jobIds, [details.batchId]);
      finishChildJobAction(id, action);
    }
  };
  const retryChildJob = async (id: string, requestedBatchId?: string) => {
    const action = beginChildJobAction(id);
    if (!action) return;
    const details = childJobDetails(id, requestedBatchId);
    const context = childJobContext();
    let retriedBatch: Batch | undefined;
    try {
      await cancelChildJobQueries(details.jobIds, [details.batchId]);
      if (!childJobActionIsCurrent(id, action, context)) return;
      const response = await deps.api.request(`jobs/${encodeURIComponent(id)}/retry`, {
        method: "POST",
        signal: action.controller.signal,
      });
      if (!response.ok) {
        const error = await readApiError(response, "Export job could not be retried. Try again.");
        throw new Error(error.message);
      }
      retriedBatch = (await response.json()) as Batch;
      if (!childJobActionIsCurrent(id, action, context)) return;
      setBatches((items) => [
        retriedBatch!,
        ...items.filter((batch) => batch.batchId !== retriedBatch!.batchId),
      ]);
      const updatesActiveContext =
        activeExportContextIsCurrent(id, action, context) &&
        (details.batchId === context.batchId || context.exportJobId === id);
      if (updatesActiveContext) {
        setBatchId(retriedBatch.batchId);
        setBatchJobs(retriedBatch.jobs);
        setExportRevision(retriedBatch.projectRevision);
        setExportJob(selectBatchJob(retriedBatch.jobs));
      }
      setExportStatus("Export retry queued as a new job.");
    } catch (error) {
      if (childJobActionIsCurrent(id, action, context))
        setExportStatus(
          error instanceof Error ? error.message : "Export job could not be retried. Try again.",
        );
    } finally {
      if (childJobActionIsCurrent(id, action, context))
        void reconcileChildJobQueries(
          [...details.jobIds, ...(retriedBatch?.jobs.map((job) => job.id) ?? [])],
          [details.batchId, retriedBatch?.batchId],
        );
      finishChildJobAction(id, action);
    }
  };
  onCleanup(clearExportContext);
  return {
    selectedExportItems,
    setSelectedExportItems,
    exportScope,
    setExportScope,
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
    destinationsLoading: () => destinationsQuery.isPending || destinationsQuery.isFetching,
    destinationsError: () =>
      destinationsQuery.error instanceof Error
        ? destinationsQuery.error.message
        : destinationsQuery.error
          ? "Destinations could not be loaded."
          : "",
    retryDestinations: () => void destinationsQuery.refetch(),
    batchesLoading: () => batchListQuery.isPending,
    batchesRefreshing: () => batchListQuery.isFetching,
    batchesError: () =>
      batchListQuery.error instanceof Error
        ? batchListQuery.error.message
        : batchListQuery.error
          ? "Export queue could not be loaded."
          : "",
    refreshBatches: () => void batchListQuery.refetch(),
    batchLoading: () => Boolean(batchId()) && batchProgressQuery.isFetching,
    batchError: () =>
      batchProgressQuery.error instanceof Error
        ? batchProgressQuery.error.message
        : batchProgressQuery.error
          ? "Export batch status could not be updated."
          : "",
    exportJobLoading: () => Boolean(exportJob()?.id) && exportStatusQuery.isFetching,
    exportJobError: () =>
      exportStatusQuery.error instanceof Error
        ? exportStatusQuery.error.message
        : exportStatusQuery.error
          ? "Export status could not be updated."
          : "",
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
      setExportContainer(value);
      deps.markDirty();
      deps.setDirty(true);
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
      setFilenameTemplate(value);
      deps.saveSettings({ filenameTemplate: value });
      deps.markDirty();
      deps.setDirty(true);
    },
    setStreams: (value: number[]) => {
      setStreamIndexes(value);
      deps.markDirty();
      deps.setDirty(true);
    },
  };
}

function useDestinationsQuery(api: ApiClient) {
  return useQuery(() => ({
    queryKey: ["destinations"],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await api.request("destinations", { signal });
      if (!response.ok) throw new Error(`Destinations could not be loaded (${response.status}).`);
      return (await response.json()) as DestinationResponse;
    },
  }));
}

function preflightRequest(
  api: ApiClient,
  projectId: string,
  input: components["schemas"]["ExportInput"],
  signal?: AbortSignal,
) {
  return api.request(`projects/${encodeURIComponent(projectId)}/exports/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
}
function useBatchQuery(
  api: ApiClient,
  batchId: Accessor<string | undefined>,
  generation: Accessor<number>,
) {
  return useQuery(() => ({
    queryKey: ["batch", batchId() ?? null, generation()],
    enabled: Boolean(batchId()),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const requestGeneration = generation();
      const id = batchId();
      if (!id) throw new Error("Batch ID is missing.");
      const response = await api.request(`batches/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Batch status could not be updated.");
      return { value: (await response.json()) as Batch, generation: requestGeneration };
    },
    refetchInterval: (query: { state: { data?: QuerySnapshot<Batch> } }) =>
      isBatchActive(query.state.data?.value) ? 1000 : false,
  }));
}
function useBatchListQuery(api: ApiClient) {
  return useQuery(() => ({
    queryKey: ["batches"],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const response = await api.request("batches?limit=50", { signal });
      if (!response.ok) throw new Error("Export queue could not be loaded.");
      return (await response.json()) as components["schemas"]["BatchPage"];
    },
    refetchInterval: (query: { state: { data?: components["schemas"]["BatchPage"] } }) =>
      query.state.data?.items?.some(isBatchActive) ? 1000 : false,
  }));
}
function useExportJobQuery(
  api: ApiClient,
  exportJob: Accessor<ExportJob | undefined>,
  generation: Accessor<number>,
) {
  return useQuery(() => ({
    queryKey: ["job", "export", exportJob()?.id ?? null, generation()],
    enabled: Boolean(exportJob()?.id),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const requestGeneration = generation();
      const id = exportJob()?.id;
      if (!id) throw new Error("Export job ID is missing.");
      const response = await api.request(`jobs/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Export status could not be updated. Try again.");
      return { value: (await response.json()) as ExportJob, generation: requestGeneration };
    },
    refetchInterval: (query: { state: { data?: QuerySnapshot<ExportJob> } }) =>
      jobPollInterval(query.state.data?.value, 1000),
  }));
}
