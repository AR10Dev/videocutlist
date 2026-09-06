import { createEffect, createSignal, onCleanup, type Accessor, type Setter } from "solid-js";
import { useQuery, type QueryClient } from "@tanstack/solid-query";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import type { EditableProjectItem } from "../projects/model";
import type { Segment } from "../preview/model";
import type { AppSettings } from "../settings/model";
import { abortAndClear, cancellationIsCurrent } from "../queue/cancellation";
import { exportFailureMessage } from "../queue/jobUi";
import { jobPollInterval } from "../queue/jobPolling";
import { parseBatchExportSubmission } from "./queueResponse";
import { destinationIsConfigured, lastDestinationId, rememberDestination } from "./destination";

type Media = components["schemas"]["Media"];
type Destination = components["schemas"]["Destination"];
type ExportJob = components["schemas"]["Job"];
type Batch = components["schemas"]["Batch"];
type Track = {
  index: number;
  type: string;
  codec: string;
  language?: string;
  disposition?: string[];
};

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
  editableItems: Accessor<EditableProjectItem[]>;
  segments: Accessor<Segment[]>;
  tracks: Accessor<Track[]>;
  saveProject: () => Promise<components["schemas"]["Project"] | undefined>;
  settings: Accessor<AppSettings>;
  markDirty: () => void;
  saveSettings: (changes: Partial<AppSettings>) => void;
}) {
  const [selectedExportItems, setSelectedExportItems] = createSignal<string[]>([]);
  const [batches, setBatches] = createSignal<Batch[]>([]);
  const [exportJob, setExportJob] = createSignal<ExportJob>();
  const [batchJobs, setBatchJobs] = createSignal<ExportJob[]>([]);
  const [batchId, setBatchId] = createSignal<string>();
  const [exportRevision, setExportRevision] = createSignal<number>();
  const [exportStatus, setExportStatus] = createSignal("");
  const [exportMode, setExportMode] = createSignal<"merge" | "separate">("merge");
  const [exportSelection, setExportSelection] = createSignal<"segments" | "gaps">("segments");
  const [cutStrategy, setCutStrategy] = createSignal(deps.settings().cutStrategy);
  const [streamIndexes, setStreamIndexes] = createSignal<number[]>([]);
  const [destinations, setDestinations] = createSignal<Destination[]>([]);
  const [destinationCapabilities, setDestinationCapabilities] = createSignal<
    components["schemas"]["DestinationCapabilities"]
  >({ saveBesideSource: false });
  const [destinationId, setDestinationId] = createSignal(lastDestinationId() ?? "download");
  const [destinationStatus, setDestinationStatus] = createSignal("");
  const [filenameTemplate, setFilenameTemplate] = createSignal(deps.settings().filenameTemplate);
  const [preflight, setPreflight] = createSignal<components["schemas"]["ExportPreflight"]>();
  const [preflightPending, setPreflightPending] = createSignal(false);
  const [exportPending, setExportPending] = createSignal(false);
  let exportTimer: number | undefined;
  let exportRequest = 0;
  let workflowRequest = 0;
  let preflightVersion = 0;
  let preflightController: AbortController | undefined;
  let workflowController: AbortController | undefined;
  let exportController: AbortController | undefined;
  let exportCancellationController: AbortController | undefined;
  let workflowActive = false;
  const invalidatedTerminalJobs = new Set<string>();
  const cancelPreflight = () => {
    preflightController?.abort();
    preflightController = undefined;
    if (exportTimer) window.clearTimeout(exportTimer);
    exportTimer = undefined;
    preflightVersion++;
  };

  const batchProgressQuery = useBatchQuery(deps.api, batchId);
  const batchListQuery = useBatchListQuery(deps.api);
  const exportStatusQuery = useExportJobQuery(deps.api, exportJob);
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
      const active = items.find((batch) => batch.state === "queued" || batch.state === "running");
      if (active) setBatchId(active.batchId);
    }
  });
  createEffect(() => {
    const next = batchProgressQuery.data;
    if (!next || next.batchId !== batchId()) return;
    setBatchJobs(next.jobs);
    setExportRevision(next.projectRevision);
    setExportJob(next.jobs[0]);
    setBatches((items) => [next, ...items.filter((batch) => batch.batchId !== next.batchId)]);
    if (next.state === "queued") setExportStatus("Export batch queued.");
    else if (next.state === "running")
      setExportStatus(`Export batch running (${Math.round(next.progress * 100)}%).`);
    else if (next.state === "succeeded") setExportStatus("Export batch complete.");
    else if (next.state === "cancelled") setExportStatus("Export batch cancelled.");
    else if (next.state === "failed") setExportStatus("Export batch failed.");
  });
  createEffect(() => {
    const next = exportStatusQuery.data;
    if (!next || next.id !== exportJob()?.id) return;
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
  void deps.api.request("destinations").then(async (response) => {
    if (!response.ok) return;
    const value = (await response.json()) as {
      destinations?: Destination[];
      capabilities?: components["schemas"]["DestinationCapabilities"];
    };
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
    const itemIDs = selectedExportItems();
    const currentItem = deps.projectItems().find((entry) => entry.media.id === item?.id);
    const preflightItemIDs = itemIDs.length ? itemIDs : currentItem ? [currentItem.id] : [];
    if (!item || !currentItem || preflightItemIDs.length === 0) {
      cancelPreflight();
      setPreflight();
      setPreflightPending(false);
      return;
    }
    deps.tracks();
    if (workflowActive || deps.dirty()) {
      cancelPreflight();
      setPreflight();
      if (!workflowActive) setPreflightPending(false);
      return;
    }
    const input = {
      mode,
      selection,
      streamIndexes: indexes,
      cutStrategy: strategy,
      container: "mkv" as const,
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
          setExportStatus("Export preflight failed. Try again.");
        } else setPreflight((await response.json()) as components["schemas"]["ExportPreflight"]);
      } catch {
        if (version === preflightVersion && !controller.signal.aborted) {
          setPreflight();
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
    exportRequest++;
    setExportJob();
    setBatchJobs([]);
    setBatchId();
    setExportRevision();
    setExportStatus("");
  };
  const exportProject = async () => {
    if (exportPending() || ["queued", "running"].includes(exportJob()?.state ?? "")) return;
    const itemIDs = [...selectedExportItems()];
    const items = deps.editableItems();
    if (!itemIDs.length) return void setExportStatus("Select at least one project item.");
    const selectedItems = items.filter((item) => itemIDs.includes(item.id));
    if (
      selectedItems.length !== itemIDs.length ||
      selectedItems.some((item) => item.timeline.present.segments.length === 0)
    )
      return void setExportStatus(
        "Add a segment to each selected project item before creating clips.",
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
      itemIDs,
      input: {
        mode: exportMode(),
        selection: exportSelection(),
        streamIndexes: [...streamIndexes()],
        cutStrategy: cutStrategy(),
        container: "mkv" as const,
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
      context.itemIDs.length === selectedExportItems().length &&
      context.itemIDs.every((id, index) => selectedExportItems()[index] === id);
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
        setExportStatus("Export preflight failed. Try again.");
        return;
      }
      const fresh = (await preflightResponse.json()) as components["schemas"]["ExportPreflight"];
      if (!workflowCurrent()) {
        stopForStaleContext();
        return;
      }
      setPreflight(fresh);
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
          body: JSON.stringify(context.input),
          signal: controller.signal,
        },
      );
      if (!workflowCurrent()) {
        stopForStaleContext();
        return;
      }
      if (!response.ok) {
        setExportStatus(
          response.status === 429
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
      const job = submission.jobs[0];
      if (job) setExportJob(job);
      setExportStatus(job?.state === "queued" ? "Export queued." : "Export running.");
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
    const job = exportJob(),
      currentBatchId = batchId();
    if (!job || !currentBatchId || (job.state !== "queued" && job.state !== "running")) return;
    exportCancellationController?.abort();
    const controller = new AbortController();
    exportCancellationController = controller;
    deps.queryClient.setQueryData(["job", "export", job.id], { ...job, state: "cancelled" });
    setExportJob();
    setExportStatus("Export batch cancellation requested.");
    try {
      const response = await deps.api.request(`batches/${encodeURIComponent(currentBatchId)}`, {
        method: "DELETE",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error("Export batch could not be cancelled.");
      if (!cancellationIsCurrent(controller, exportCancellationController)) return;
      exportController?.abort();
      exportController = undefined;
      setExportJob({ ...job, state: "cancelled" });
      setExportStatus("Export cancelled.");
    } catch (error) {
      if (!controller.signal.aborted) {
        if (cancellationIsCurrent(controller, exportCancellationController)) setExportJob(job);
        setExportStatus(
          error instanceof Error ? error.message : "Export could not be cancelled. Try again.",
        );
      }
    } finally {
      if (exportCancellationController === controller) exportCancellationController = undefined;
    }
  };
  const cancelBatch = async (id: string) => {
    const response = await deps.api.request(`batches/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (!response.ok) return setExportStatus("Export batch could not be cancelled.");
    setBatches((items) =>
      items.map((batch) => (batch.batchId === id ? { ...batch, state: "cancelled" } : batch)),
    );
    void deps.queryClient.invalidateQueries({ queryKey: ["batches"] });
  };
  const cancelChildJob = async (id: string) => {
    const response = await deps.api.request(`jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (!response.ok) return setExportStatus("Export job could not be cancelled.");
    void deps.queryClient.invalidateQueries({ queryKey: ["batches"] });
    if (batchId()) void deps.queryClient.invalidateQueries({ queryKey: ["batch", batchId()] });
  };
  const retryChildJob = async (id: string) => {
    const response = await deps.api.request(`jobs/${encodeURIComponent(id)}/retry`, {
      method: "POST",
    });
    if (!response.ok) return setExportStatus("Export job could not be retried.");
    const batch = (await response.json()) as Batch;
    setBatches((items) => [batch, ...items]);
    setBatchId(batch.batchId);
    setExportStatus("Export retry queued as a new job.");
  };
  onCleanup(clearExportContext);
  return {
    selectedExportItems,
    setSelectedExportItems,
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
    exportPending,
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
    setDestination: (value: string) => {
      setDestinationId(value);
      if (destinationIsConfigured(value, destinations())) {
        rememberDestination(value);
        setDestinationStatus("");
      }
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
function useBatchQuery(api: ApiClient, batchId: Accessor<string | undefined>) {
  return useQuery(() => ({
    queryKey: ["batch", batchId() ?? null],
    enabled: Boolean(batchId()),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const id = batchId();
      if (!id) throw new Error("Batch ID is missing.");
      const response = await api.request(`batches/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Batch status could not be updated.");
      return (await response.json()) as Batch;
    },
    refetchInterval: (query: { state: { data?: Batch } }) =>
      ["succeeded", "failed", "cancelled"].includes(query.state.data?.state ?? "") ? false : 1000,
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
      query.state.data?.items?.some(
        (batch) => batch.state === "queued" || batch.state === "running",
      )
        ? 1000
        : false,
  }));
}
function useExportJobQuery(api: ApiClient, exportJob: Accessor<ExportJob | undefined>) {
  return useQuery(() => ({
    queryKey: ["job", "export", exportJob()?.id ?? null],
    enabled: Boolean(exportJob()?.id),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const id = exportJob()?.id;
      if (!id) throw new Error("Export job ID is missing.");
      const response = await api.request(`jobs/${encodeURIComponent(id)}`, { signal });
      if (!response.ok) throw new Error("Export status could not be updated. Try again.");
      return (await response.json()) as ExportJob;
    },
    refetchInterval: (query: { state: { data?: ExportJob } }) =>
      jobPollInterval(query.state.data, 1000),
  }));
}
