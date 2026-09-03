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
  projectItems: Accessor<EditableProjectItem[]>;
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
  const [destinationId, setDestinationId] = createSignal("download");
  const [filenameTemplate, setFilenameTemplate] = createSignal(deps.settings().filenameTemplate);
  const [preflight, setPreflight] = createSignal<components["schemas"]["ExportPreflight"]>();
  const [preflightPending, setPreflightPending] = createSignal(false);
  let exportTimer: number | undefined;
  let exportRequest = 0;
  let preflightVersion = 0;
  let exportController: AbortController | undefined;
  let exportCancellationController: AbortController | undefined;
  const invalidatedTerminalJobs = new Set<string>();

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
    const value = (await response.json()) as { destinations?: Destination[] };
    const items = Array.isArray(value.destinations) ? value.destinations : [];
    setDestinations(items);
    if (items.length && !items.some((item) => item.id === destinationId()))
      setDestinationId(items[0].id);
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
    if (!item) {
      setPreflight();
      setPreflightPending(false);
      return;
    }
    deps.tracks();
    if (deps.projectItems().length > 1) {
      setPreflight({ allowed: true, selection: [], findings: [] });
      setPreflightPending(false);
      return;
    }
    if (exportTimer) window.clearTimeout(exportTimer);
    deps.dirty();
    setPreflightPending(true);
    const version = ++preflightVersion;
    exportTimer = window.setTimeout(async () => {
      try {
        const response = await deps.api.request(
          `projects/${encodeURIComponent(currentProjectID)}/exports/preflight`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode,
              selection,
              streamIndexes: indexes,
              cutStrategy: strategy,
              container: "mkv",
              destinationId: destination,
              filenameTemplate: template,
            }),
          },
        );
        if (version !== preflightVersion) return;
        setPreflight(response.ok ? await response.json() : blockedPreflight());
      } catch {
        if (version === preflightVersion) setPreflight(blockedPreflight());
      }
      if (version === preflightVersion) setPreflightPending(false);
    }, 250);
  });

  const clearExportContext = () => {
    exportController = abortAndClear(exportController);
    exportCancellationController = abortAndClear(exportCancellationController);
    exportRequest++;
    if (exportTimer) window.clearTimeout(exportTimer);
    exportTimer = undefined;
    setExportJob();
    setBatchJobs([]);
    setBatchId();
    setExportRevision();
    setExportStatus("");
  };
  const exportProject = async () => {
    if (preflightPending() && !deps.dirty()) return;
    if (!selectedExportItems().length)
      return void setExportStatus("Select at least one project item.");
    if (deps.dirty()) {
      if (!(await deps.saveProject())) return;
      if (deps.projectItems().length === 1) {
        const response = await preflightRequest(
          deps.api,
          deps.projectId(),
          exportMode(),
          exportSelection(),
          streamIndexes(),
          cutStrategy(),
          destinationId(),
          filenameTemplate(),
        );
        if (!response.ok) return void setExportStatus("Export preflight failed.");
        const fresh = (await response.json()) as components["schemas"]["ExportPreflight"];
        setPreflight(fresh);
        setPreflightPending(false);
        if (!fresh.allowed) return;
      }
    } else if (deps.projectItems().length === 1 && !preflight()?.allowed) return;
    const request = ++exportRequest;
    const controller = new AbortController();
    exportController = controller;
    if (exportTimer) clearTimeout(exportTimer);
    setExportStatus("Starting export…");
    try {
      const response = await deps.api.request(
        `projects/${encodeURIComponent(deps.projectId())}/exports`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: exportMode(),
            selection: exportSelection(),
            streamIndexes: streamIndexes(),
            cutStrategy: cutStrategy(),
            container: "mkv",
            destinationId: destinationId(),
            filenameTemplate: filenameTemplate(),
            itemIds:
              selectedExportItems().length === deps.projectItems().length
                ? undefined
                : selectedExportItems(),
          }),
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted || request !== exportRequest) return;
      if (!response.ok)
        return void setExportStatus(
          response.status === 429
            ? "Export capacity is busy. Try again shortly."
            : "Export could not be started. Try again.",
        );
      const submission = parseBatchExportSubmission(await response.json());
      if (controller.signal.aborted || request !== exportRequest) return;
      setBatchId(submission.batchId);
      setExportRevision(deps.revision());
      setBatchJobs(submission.jobs);
      setBatches((items) => [
        {
          batchId: submission.batchId,
          projectId: deps.projectId(),
          projectRevision: deps.revision(),
          state: "queued",
          progress: 0,
          jobs: submission.jobs,
        },
        ...items.filter((batch) => batch.batchId !== submission.batchId),
      ]);
      void deps.queryClient.invalidateQueries({ queryKey: ["batches"] });
      const job = submission.jobs[0];
      if (job) setExportJob(job);
      setExportStatus(job?.state === "queued" ? "Export queued." : "Export running.");
    } catch (error) {
      if (!controller.signal.aborted && request === exportRequest)
        setExportStatus(
          error instanceof Error ? error.message : "Export could not be started. Try again.",
        );
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
    destinationId,
    setDestinationId,
    filenameTemplate,
    setFilenameTemplate,
    preflight,
    preflightPending,
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

function blockedPreflight(): components["schemas"]["ExportPreflight"] {
  return {
    allowed: false,
    selection: [],
    findings: [
      { severity: "blocked", code: "preflight_failed", message: "Export preflight failed." },
    ],
  };
}
function preflightRequest(
  api: ApiClient,
  projectId: string,
  mode: string,
  selection: string,
  streamIndexes: number[],
  cutStrategy: string,
  destinationId: string,
  filenameTemplate: string,
) {
  return api.request(`projects/${encodeURIComponent(projectId)}/exports/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode,
      selection,
      streamIndexes,
      cutStrategy,
      container: "mkv",
      destinationId,
      filenameTemplate,
    }),
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
