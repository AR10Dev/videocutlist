import type * as EffectApiTypes from "../../generated/effect-api";
import { onCleanup, type Accessor, type Setter } from "solid-js";
import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Exit } from "effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { ApiFailure, apiErrorEnvelope, uncertainCommandFailure } from "../../api";
import { readServerAtom, runServerMutation, useServerAtom, type ServerState } from "../app/server";
import { createExportQueue } from "./queue";
import { requestErrorMessage, resourceErrorMessage } from "./errors";
import { syncCommand } from "../app/syncCommand";
import { Batch as BatchSchema } from "../../generated/effect-api";
import type { EditableProjectItem, ExportContainer } from "../projects/model";
import {
  validFilenameTemplateLength,
  type AppSettings,
  type BrowserPreferences,
} from "../settings/model";
import { isJobActive, idempotencyKeyForAttempt, selectBatchJob } from "./queueResponse";
import { destinationIsConfigured } from "./destination";

type Media = EffectApiTypes.Media;
type ExportPreflight = import("../../generated/effect-api").ExportPreflight;
const preflightFailureMessage = (failure: unknown): string => {
  if (failure instanceof ApiFailure)
    return `Export preflight failed (${failure.status}). Try again.`;
  const error = apiErrorEnvelope(failure);
  return error
    ? `Export preflight failed (${error.code}): ${error.message} (request ${error.requestId})`
    : "Export preflight could not be reached. Try again.";
};

export type ExportScope = "active" | "selected";

export function createExportController(deps: {
  server: ServerState;
  itemsAtom: Atom.Writable<EditableProjectItem[]>;
  optionsContext: Atom.Atom<{ activeItemId?: string; selectedMediaId?: string }>;
  preflightContext: Atom.Atom<{
    projectId: string;
    revision: number;
    dirty: boolean;
    editVersion: number;
    generation?: number;
  }>;
  selected: Accessor<Media | undefined>;
  projectId: Accessor<string>;
  revision: Accessor<number>;
  dirty: Accessor<boolean>;
  editorVersion: Accessor<number>;
  status: Accessor<string>;
  editableItems: Accessor<EditableProjectItem[]>;
  saveProject: () => Effect.Effect<EffectApiTypes.Project | undefined, Error>;
  markDirty: () => void;
  saveSettings: (changes: Partial<BrowserPreferences>) => void;
}) {
  const registry = deps.server.registry;
  const runtime = deps.server.runtime;
  const selectionAtom = Atom.keepAlive(
    Atom.make({
      scope: "active" as ExportScope,
      ids: [] as string[],
      explicitContainer: undefined as ExportContainer | undefined,
    }),
  );
  const selectionValue = useAtomValue(() => selectionAtom);
  const selectedItemsAtom = Atom.make((get) => {
    const ids = new Set(get(deps.itemsAtom).map((item) => item.id));
    return get(selectionAtom).ids.filter((id) => ids.has(id));
  });
  const selectedExportItems = useAtomValue(() => selectedItemsAtom);
  const exportScope = () => selectionValue().scope;
  const itemIDsAtom = Atom.make((get) => {
    if (get(selectionAtom).scope === "selected") return get(selectedItemsAtom);
    const context = get(deps.optionsContext);
    const item = get(deps.itemsAtom).find(
      (item) => item.id === context.activeItemId || item.media.id === context.selectedMediaId,
    );
    return item ? [item.id] : [];
  });
  const exportItemIDs = useAtomValue(() => itemIDsAtom);
  const previewOptions = Atom.keepAlive(
    Atom.make<EditableProjectItem["exportOptions"]>({
      mode: "separate",
      selection: "segments",
      container: "mkv",
    }),
  );
  const optionsAtom = Atom.writable<
    EditableProjectItem["exportOptions"],
    EditableProjectItem["exportOptions"]
  >(
    (get) =>
      get(deps.itemsAtom).find((item) => item.id === get(deps.optionsContext).activeItemId)
        ?.exportOptions ?? get(previewOptions),
    (ctx, options) => {
      const id = ctx.get(deps.optionsContext).activeItemId;
      const items = ctx.get(deps.itemsAtom);
      if (items.some((item) => item.id === id))
        ctx.set(
          deps.itemsAtom,
          items.map((item) => (item.id === id ? { ...item, exportOptions: options } : item)),
        );
      else ctx.set(previewOptions, options);
    },
  );
  const optionsValue = useAtomValue(() => optionsAtom);
  const preferences = useAtomValue(() => deps.server.preferences.value);

  const option = <K extends keyof EditableProjectItem["exportOptions"]>(
    key: K,
    fallback: () => NonNullable<EditableProjectItem["exportOptions"][K]>,
  ) => {
    type Value = NonNullable<EditableProjectItem["exportOptions"][K]>;
    const read = () => (optionsValue()[key] ?? fallback()) as Value;
    const writeValue = syncCommand<Value | ((value: Value) => Value), Value>(
      registry,
      (input) => {
        const current = registry.get(optionsAtom)[key] ?? fallback();
        const value =
          typeof input === "function"
            ? (input as (value: Value) => Value)(current as Value)
            : input;
        registry.set(optionsAtom, { ...registry.get(optionsAtom), [key]: value });
        return value;
      },
      () => new Error(`Unable to update export ${String(key)}.`),
    );
    const write = writeValue as Setter<Value>;
    return [read, write] as const;
  };
  const [exportMode, setExportMode] = option("mode", () => "merge");
  const [exportSelection, setExportSelection] = option("selection", () => "segments");
  const [cutStrategy, setCutStrategy] = option("cutStrategy", () => preferences().cutStrategy);
  const [exportContainer, writeContainer] = option("container", () => "mkv");
  const resetContainerChoice = () => {
    registry.update(selectionAtom, (state) => ({ ...state, explicitContainer: undefined }));
  };
  const setExportContainer: Setter<ExportContainer> = (
    input: ExportContainer | ((value: ExportContainer) => ExportContainer),
  ) => {
    registry.update(selectionAtom, (state) => ({ ...state, explicitContainer: undefined }));
    return writeContainer(input);
  };
  const [streamIndexes, setStreamIndexes] = option("streamIndexes", () => []);
  const [destinationId, setDestinationId] = option(
    "destinationId",
    () => preferences().lastDestinationId ?? "download",
  );
  const [filenameTemplate, setFilenameTemplate] = option(
    "filenameTemplate",
    () => preferences().filenameTemplate,
  );
  const noticeAtom = Atom.keepAlive(Atom.make(""));
  const destinationStatus = useAtomValue(() => noticeAtom);
  const setDestinationStatus = (value: string) => registry.set(noticeAtom, value);
  const setSelectedExportItems: Setter<string[]> = (
    input: string[] | ((value: string[]) => string[]),
  ) => {
    const value = typeof input === "function" ? input(registry.get(selectedItemsAtom)) : input;
    const ids = value.filter((id) => registry.get(deps.itemsAtom).some((item) => item.id === id));
    registry.update(selectionAtom, (state) => ({ ...state, ids }));
    return ids;
  };
  const pruneSelection = () => {
    const state = registry.get(selectionAtom);
    const ids = registry.get(selectedItemsAtom);
    if (ids.length !== state.ids.length) registry.set(selectionAtom, { ...state, ids });
  };
  const stopPruning = registry.subscribe(deps.itemsAtom, pruneSelection);
  onCleanup(stopPruning);
  const queueContext = Atom.make((get) => {
    const context = get(deps.preflightContext);
    return {
      projectId: context.projectId,
      revision: context.revision,
      editVersion: context.editVersion,
      generation: context.generation,
      selectedMediaId: get(deps.optionsContext).selectedMediaId,
    };
  });
  const queue = createExportQueue({
    server: deps.server,
    context: queueContext,
    currentContext: () => ({
      projectId: deps.projectId(),
      revision: deps.revision(),
      editVersion: deps.editorVersion(),
      generation: registry.get(deps.preflightContext).generation,
      selectedMediaId: deps.selected()?.id,
    }),
  });
  const { batches, batchId, batchJobs, exportJob, exportCancellationPending } = queue.view;
  const setExportStatus = queue.setStatus;
  const applyChosenContainer = (ids: readonly string[], value: ExportContainer) => {
    if (!ids.length) return false;
    const selectedIds = new Set(ids);
    const items = registry.get(deps.itemsAtom);
    if (!items.some((item) => selectedIds.has(item.id) && item.exportOptions.container !== value))
      return false;
    registry.set(
      deps.itemsAtom,
      items.map((item) =>
        selectedIds.has(item.id)
          ? { ...item, exportOptions: { ...item.exportOptions, container: value } }
          : item,
      ),
    );
    deps.markDirty();
    return true;
  };
  const chooseExportScope = (value: ExportScope) => {
    registry.update(selectionAtom, (state) => ({ ...state, scope: value }));
    const container = registry.get(selectionAtom).explicitContainer;
    if (container) applyChosenContainer(registry.get(itemIDsAtom), container);
  };
  const chooseExportItems: Setter<string[]> = (value: string[] | ((ids: string[]) => string[])) => {
    const ids = setSelectedExportItems(value);
    const state = registry.get(selectionAtom);
    if (state.scope === "selected" && state.explicitContainer)
      applyChosenContainer(ids, state.explicitContainer);
    return ids;
  };
  const exportPhaseAtom = Atom.keepAlive(
    Atom.make<"saving" | "preflight" | "submitting" | undefined>(undefined),
  );
  const generatedMutation = <Arg, A, E>(
    atom: Atom.AtomResultFn<Arg, A, E>,
    argument: Arg,
  ): Effect.Effect<A, E> => runServerMutation(registry, atom, argument);
  const generatedApi = deps.server.generatedApi;
  const preflightMutation = generatedApi.mutation("default", "preflightExport");
  const preflightRequest = (request: { projectId: string; input: EffectApiTypes.ExportInput }) =>
    generatedMutation(preflightMutation, {
      params: { projectId: request.projectId },
      payload: request.input,
    });
  const preflightKey = Atom.make((get) => {
    const context = get(deps.preflightContext);
    const active = get(deps.optionsContext);
    const ids = get(itemIDsAtom);
    const options = get(optionsAtom);
    const preferences = get(deps.server.preferences.value);
    const items = get(deps.itemsAtom);
    return JSON.stringify({
      projectId: context.projectId,
      revision: context.revision,
      dirty: context.dirty,
      editVersion: context.editVersion,
      generation: context.generation,
      activeItemId: active.activeItemId,
      selectedMediaId: active.selectedMediaId,
      scope: get(selectionAtom).scope,
      items: items
        .filter((item) => ids.includes(item.id))
        .map((item) => ({
          id: item.id,
          exportOptions: item.exportOptions,
        })),
      input: {
        mode: options.mode ?? "merge",
        selection: options.selection ?? "segments",
        streamIndexes: options.streamIndexes ?? [],
        cutStrategy: options.cutStrategy ?? preferences.cutStrategy,
        container: options.container ?? "mkv",
        destinationId: options.destinationId ?? preferences.lastDestinationId ?? "download",
        filenameTemplate: options.filenameTemplate ?? preferences.filenameTemplate,
        itemIds: ids,
      } satisfies EffectApiTypes.ExportInput,
      valid: Boolean(
        active.selectedMediaId &&
        ids.length &&
        items.some((item) => item.media.id === active.selectedMediaId),
      ),
    });
  });
  type PreflightContext = {
    projectId: string;
    input: EffectApiTypes.ExportInput;
    dirty: boolean;
    valid: boolean;
  };
  const preflightIntent = Atom.keepAlive(
    Atom.make<{ mode: "automatic" } | { mode: "submission" | "checked"; key?: string }>({
      mode: "automatic",
    }),
  );
  const automaticPreflight = Atom.keepAlive(
    runtime.atom<ExportPreflight | undefined, unknown>((get) => {
      const key = get(preflightKey);
      const intent = get(preflightIntent);
      let context: PreflightContext;
      try {
        context = JSON.parse(key) as PreflightContext;
      } catch (cause) {
        return Effect.fail(new Error("Invalid export preflight context.", { cause }));
      }
      if (
        !context.valid ||
        context.dirty ||
        intent.mode === "submission" ||
        (intent.mode === "checked" && intent.key === key)
      )
        return Effect.succeed<ExportPreflight | undefined>(undefined);
      return Effect.andThen(Effect.sleep(250), preflightRequest(context));
    }),
  );
  const preflightCommand = Atom.keepAlive(
    runtime.fn(
      (
        request: { projectId: string; input: EffectApiTypes.ExportInput; key: string },
        get,
      ): ReturnType<typeof preflightRequest> => {
        if (get(preflightKey) !== request.key) return Effect.interrupt;
        // Function atoms read once; observe the key to interrupt, never replay, a mutation.
        get.subscribe(preflightKey, (key) => {
          if (key !== request.key) registry.set(preflightCommand, Atom.Interrupt);
        });
        return preflightRequest(request);
      },
    ),
  );
  const preflightResultAtom = Atom.make((get) => {
    const intent = get(preflightIntent);
    const result =
      intent.mode !== "automatic" && intent.key === get(preflightKey)
        ? get(preflightCommand)
        : get(automaticPreflight);
    // Native results retain previous successes during refresh; obsolete checks must not render.
    return result.waiting
      ? AsyncResult.initial<ExportPreflight | undefined, unknown>(true)
      : result;
  });
  const observedPreflight = useAtomValue(() => preflightResultAtom);
  const preflightResult = () => {
    observedPreflight();
    return registry.get(preflightResultAtom);
  };
  const preflight = () => {
    const result = preflightResult();
    return AsyncResult.isSuccess(result) ? result.value : undefined;
  };
  const preflightPending = () => preflightResult().waiting;
  const preflightError = () => {
    const result = preflightResult();
    return AsyncResult.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)
      ? preflightFailureMessage(Cause.squash(result.cause))
      : "";
  };
  const suspendAutomaticPreflight = () => {
    registry.set(preflightIntent, { mode: "submission" });
    // Evaluate the dependency change now, releasing the old mutation before a fresh check.
    registry.get(automaticPreflight);
    registry.set(preflightCommand, Atom.Reset);
  };
  const freshPreflight = (request: { projectId: string; input: EffectApiTypes.ExportInput }) =>
    Effect.suspend(() => {
      const key = registry.get(preflightKey);
      registry.set(preflightIntent, { mode: "submission", key });
      registry.set(preflightCommand, { ...request, key });
      return readServerAtom(deps.server, preflightCommand);
    });
  const cancelPreflight = () => {
    registry.set(preflightIntent, { mode: "checked", key: registry.get(preflightKey) });
    registry.get(automaticPreflight);
    registry.set(preflightCommand, Atom.Reset);
  };
  const retryPreflight = () => {
    if (registry.get(preflightIntent).mode === "submission") return;
    registry.set(preflightIntent, { mode: "automatic" });
    registry.refresh(automaticPreflight);
  };

  const destinationAtom = generatedApi.query("default", "listDestinations", {});
  const destinationResult = useServerAtom(() => destinationAtom);
  const destinationsAtom = Atom.make((get) => {
    const result = get(destinationAtom);
    return AsyncResult.value(result).pipe(
      Option.map((value) => [...value.destinations]),
      Option.getOrElse(() => []),
    );
  });
  const destinations = useAtomValue(() => destinationsAtom);
  const capabilitiesAtom = Atom.make((get) => {
    const result = get(destinationAtom);
    return AsyncResult.value(result).pipe(
      Option.map((value) => value.capabilities),
      Option.getOrElse(() => ({ saveBesideSource: false })),
    );
  });
  const destinationCapabilities = useAtomValue(() => capabilitiesAtom);
  const availableDestinationsAtom = Atom.make((get) =>
    get(destinationsAtom).filter(
      (destination) =>
        destination.kind !== "source_adjacent" || get(capabilitiesAtom).saveBesideSource,
    ),
  );
  const availableDestinations = useAtomValue(() => availableDestinationsAtom);
  const fallbackCommand = () => {
    const configured = registry.get(availableDestinationsAtom);
    const options = registry.get(optionsAtom);
    const current =
      options.destinationId ??
      registry.get(deps.server.preferences.value).lastDestinationId ??
      "download";
    if (configured.length && !destinationIsConfigured(current, configured)) {
      const activeItemId = registry.get(deps.optionsContext).activeItemId;
      const editsItem = registry.get(deps.itemsAtom).some((item) => item.id === activeItemId);
      registry.set(optionsAtom, { ...options, destinationId: configured[0].id });
      if (editsItem) {
        deps.markDirty();
      }
      setDestinationStatus(
        "Remembered destination is unavailable. Using " + configured[0].label + ".",
      );
    }
  };
  const fallbackInputs = Atom.make((get) => [
    get(availableDestinationsAtom),
    get(optionsAtom),
    get(deps.server.preferences.value),
  ]);
  const stopFallback = registry.subscribe(fallbackInputs, fallbackCommand, { immediate: true });
  onCleanup(stopFallback);
  const uncertainExportAtom = Atom.keepAlive(
    Atom.make<
      | {
          key: string;
          projectId: string;
          body: EffectApiTypes.ExportSubmissionInput;
        }
      | undefined
    >(undefined),
  );
  const isUncertainExportFailure = (error: unknown) =>
    uncertainCommandFailure(error, [
      "export_busy",
      "idempotency_conflict",
      "invalid_idempotency_key",
      "invalid_export",
      "stale_project",
      "origin_forbidden",
    ]);
  const optionsIdentity = (key: string) => {
    try {
      const {
        revision: _revision,
        dirty: _dirty,
        ...identity
      } = JSON.parse(key) as Record<string, unknown>;
      return JSON.stringify(identity);
    } catch (cause) {
      throw new Error("Invalid export options identity.", { cause });
    }
  };
  const clearExportContext = () => {
    registry.set(exportCommand, Atom.Interrupt);
    cancelPreflight();
    queue.clearContext();
  };
  const exportCommand = Atom.keepAlive(
    runtime.fn(() =>
      Effect.gen(function* () {
        const cancellationPending = exportCancellationPending();
        if (
          !cancellationPending &&
          (isJobActive(exportJob()) ||
            batchJobs().some(isJobActive) ||
            (batchId() &&
              batches()
                .find((batch) => batch.batchId === batchId())
                ?.jobs.some(isJobActive)))
        )
          return;
        queue.beginSubmission();
        const itemIDs = [...exportItemIDs()];
        const items = deps.editableItems();
        if (!itemIDs.length) return void setExportStatus("Select at least one project item.");
        const selectedItems = items.filter((item) => itemIDs.includes(item.id));
        const selection = exportSelection();
        if (
          selectedItems.length !== itemIDs.length ||
          (selection === "segments" &&
            selectedItems.some(
              (item) =>
                !item.timeline.present.segments.some((segment) => segment.included !== false),
            ))
        )
          return void setExportStatus(
            selection === "gaps"
              ? "Select a project item before creating gap exports."
              : "Add or include a segment in each selected project item before creating clips.",
          );

        const context = {
          projectId: deps.projectId(),
          mediaId: deps.selected()?.id,
          editorVersion: deps.editorVersion(),
          revision: deps.revision(),
          generation: registry.get(deps.preflightContext).generation,
          optionsKey: registry.get(preflightKey),
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
        const attempt = {
          context,
          expectedRevision: context.revision,
          savedRevision: context.revision,
        };
        const editorContextCurrent = () =>
          attempt.context.projectId === deps.projectId() &&
          attempt.expectedRevision === deps.revision() &&
          attempt.context.mediaId === deps.selected()?.id &&
          attempt.context.editorVersion === deps.editorVersion() &&
          attempt.context.generation === registry.get(deps.preflightContext).generation &&
          optionsIdentity(attempt.context.optionsKey) ===
            optionsIdentity(registry.get(preflightKey)) &&
          attempt.context.scope === exportScope() &&
          attempt.context.itemIDs.length === exportItemIDs().length &&
          attempt.context.itemIDs.every((id, index) => exportItemIDs()[index] === id);
        const workflowCurrent = editorContextCurrent;
        const continueIfCurrent = () => {
          if (workflowCurrent()) return true;
          setExportStatus(
            "Create clips stopped because the project changed. Save again and retry.",
          );
          return false;
        };
        const setAttemptPhase = (phase: "saving" | "preflight" | "submitting") => {
          registry.set(exportPhaseAtom, phase);
          setExportStatus(
            phase === "saving"
              ? "Saving project…"
              : phase === "preflight"
                ? "Checking export requirements…"
                : "Creating clips…",
          );
        };
        suspendAutomaticPreflight();
        setAttemptPhase(deps.dirty() ? "saving" : "preflight");
        yield* Effect.gen(function* () {
          if (deps.dirty()) {
            const saved = yield* deps.saveProject();
            if (!saved) {
              if (continueIfCurrent())
                setExportStatus(deps.status() || "Project could not be saved. Try again.");
              return;
            }
            attempt.expectedRevision = saved.revision;
            if (!continueIfCurrent()) return;
            attempt.savedRevision = saved.revision;
          }
          if (!continueIfCurrent()) return;
          setAttemptPhase("preflight");
          const checked = yield* Effect.exit(
            freshPreflight({
              projectId: attempt.context.projectId,
              input: { ...attempt.context.input, itemIds: [...attempt.context.itemIDs] },
            }),
          );
          if (!continueIfCurrent()) return;
          if (Exit.isFailure(checked)) {
            setExportStatus(
              Cause.hasInterruptsOnly(checked.cause)
                ? "Create clips stopped because the project changed. Save again and retry."
                : "Export preflight failed. Try again.",
            );
            return;
          }
          const fresh = checked.value;
          if (!fresh.allowed) {
            setExportStatus("");
            return;
          }
          if (!continueIfCurrent()) return;
          setAttemptPhase("submitting");
          const submissionBody: EffectApiTypes.ExportSubmissionInput = {
            projectRevision: attempt.savedRevision,
            ...(attempt.context.input.itemIds ? { itemIds: attempt.context.input.itemIds } : {}),
          };
          const uncertainExport = registry.get(uncertainExportAtom);
          const retry =
            uncertainExport?.projectId === attempt.context.projectId ? uncertainExport : undefined;
          const key = idempotencyKeyForAttempt(retry, submissionBody, () =>
            globalThis.crypto.randomUUID(),
          );
          // Record before sending: interruption cannot establish whether Go admitted the batch.
          registry.set(uncertainExportAtom, {
            key,
            projectId: context.projectId,
            body: submissionBody,
          });
          const create = deps.server.generatedApi.mutation("default", "createExport");
          const response = yield* Effect.exit(
            generatedMutation(create, {
              params: { projectId: attempt.context.projectId },
              headers: { "Idempotency-Key": key },
              payload: submissionBody,
            }).pipe(
              Effect.mapError((error) => {
                registry.set(
                  uncertainExportAtom,
                  isUncertainExportFailure(error)
                    ? { key, projectId: attempt.context.projectId, body: submissionBody }
                    : undefined,
                );
                if (error instanceof Error) return error;
                const envelope = apiErrorEnvelope(error);
                return envelope
                  ? Object.assign(new Error(envelope.message), { error: envelope })
                  : new Error("Export request failed.");
              }),
            ),
          );
          if (Exit.isFailure(response)) {
            if (!continueIfCurrent()) return;
            const failure = Cause.squash(response.cause);
            if (apiErrorEnvelope(failure)?.code === "export_busy") {
              setExportStatus("Export capacity is busy. Try again shortly.");
              return;
            }
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
          // The generated createExport endpoint has already decoded this response.
          const submission = response.value;
          registry.set(uncertainExportAtom, undefined);
          if (!continueIfCurrent()) return;
          const initialBatch = Schema.decodeUnknownSync(BatchSchema)({
            batchId: submission.batchId,
            projectId: attempt.context.projectId,
            projectRevision: attempt.savedRevision,
            state: "queued",
            progress: 0,
            jobs: submission.jobs,
          });
          queue.acceptSubmission(initialBatch);
          const job = selectBatchJob(submission.jobs);
          setExportStatus(
            job?.state === "queued"
              ? "Export queued."
              : job?.state === "running"
                ? "Export running."
                : "Export complete.",
          );
        }).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => {
              if (workflowCurrent())
                setExportStatus(
                  requestErrorMessage(error, "Export could not be started. Try again."),
                );
              else continueIfCurrent();
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              registry.set(exportPhaseAtom, undefined);
              const intent = registry.get(preflightIntent);
              if (intent.mode === "submission")
                registry.set(preflightIntent, { mode: "checked", key: intent.key });
            }),
          ),
        );
      }),
    ),
  );
  const exportResult = useAtomValue(() => exportCommand);
  const exportPending = () => exportResult().waiting;
  const exportProject = () => {
    if (!registry.get(exportCommand).waiting) registry.set(exportCommand, undefined);
  };
  const updateItemDestination = ({ id, value }: { id: string; value: string }) => {
    if (
      destinations().some(
        (destination) => destination.id === value && destination.kind === "source_adjacent",
      ) &&
      !destinationCapabilities().saveBesideSource
    )
      return;
    registry.update(deps.itemsAtom, (items) =>
      items.map((item) =>
        item.id === id
          ? { ...item, exportOptions: { ...item.exportOptions, destinationId: value } }
          : item,
      ),
    );
    deps.markDirty();
  };
  onCleanup(clearExportContext);
  return {
    selectedExportItems,
    setSelectedExportItems,
    chooseExportItems,
    chooseExportScope,
    exportScope,
    exportItemIDs,
    ...queue.view,
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
    availableDestinations,
    optionsAtom,
    selectionAtom,
    resetContainerChoice,
    destinationCapabilities,
    destinationId,
    setDestinationId,
    filenameTemplate,
    setFilenameTemplate,
    preflight,
    preflightResult,
    preflightPending,
    preflightError,
    retryPreflight,
    exportPending,
    exportCommand,
    exportPhase: useAtomValue(() => exportPhaseAtom),
    destinationsLoading: () => destinationResult.waiting(),
    destinationsError: () =>
      resourceErrorMessage(destinationResult.result(), "Request could not be completed."),
    retryDestinations: () => registry.refresh(destinationAtom),
    destinationStatus,
    clearExportContext,
    exportProject,
    setMode: (value: "merge" | "separate") => {
      setExportMode(value);
      deps.markDirty();
    },
    setSelection: (value: "segments" | "gaps") => {
      setExportSelection(value);
      deps.markDirty();
    },
    setStrategy: (value: AppSettings["cutStrategy"]) => {
      setCutStrategy(value);
      deps.saveSettings({ cutStrategy: value });
      deps.markDirty();
    },
    setContainer: (value: ExportContainer) => {
      registry.update(selectionAtom, (state) => ({ ...state, explicitContainer: value }));
      writeContainer(value);
      if (!applyChosenContainer(exportItemIDs(), value)) {
        deps.markDirty();
      }
    },
    setDestination: (value: string) => {
      if (
        destinations().some(
          (destination) => destination.id === value && destination.kind === "source_adjacent",
        ) &&
        !destinationCapabilities().saveBesideSource
      )
        return;
      setDestinationId(value);
      if (destinationIsConfigured(value, availableDestinations())) {
        deps.saveSettings({ lastDestinationId: value });
        setDestinationStatus("");
      }
      deps.markDirty();
    },
    setItemDestination: (id: string, value: string) => updateItemDestination({ id, value }),
    setTemplate: (value: string) => {
      if (!validFilenameTemplateLength(value)) return false;
      setFilenameTemplate(value);
      deps.saveSettings({ filenameTemplate: value });
      deps.markDirty();
      return true;
    },
    setStreams: (value: number[]) => {
      setStreamIndexes(value);
      deps.markDirty();
    },
  };
}
