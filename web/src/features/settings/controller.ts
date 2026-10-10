import type * as EffectApiTypes from "../../generated/effect-api";
import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { getOwner, onCleanup } from "solid-js";
import { apiErrorCode, type ApiClient, uncertainCommandFailure } from "../../api";
import type {
  GetMCPSettings200,
  SettingsResponse as GeneratedSettingsResponse,
} from "../../generated/effect-api";
import { runServerMutation, serverResultError, type ServerState } from "../app/server";
import {
  validFilenameTemplateLength,
  defaultBrowserPreferences,
  validRuntimeSettingsInput,
  type BrowserPreferences,
} from "./model";
import { validDestinationId } from "../export/destination";

type LibraryRoot = {
  alias: string;
  state?: "ready" | "unavailable";
  message?: string;
};
type ServerRuntimeSettings = EffectApiTypes.SettingsResponse["settings"];
type MCPSettings = GetMCPSettings200;
type MCPCredentialCreate = EffectApiTypes.MCPCredentialCreate;

const originMessage =
  "This browser origin is not allowed by the server. Check the deployment CORS settings.";
const mcpRefreshMessage =
  "MCP settings could not be refreshed. Displayed data may be outdated. Retry refresh.";

function isUncertainRequestError(error: unknown): boolean {
  return uncertainCommandFailure(error, [
    "origin_forbidden",
    "library_busy",
    "invalid_idempotency_key",
    "idempotency_conflict",
    "refresh_unavailable",
  ]);
}

export function createSettingsController(api: ApiClient, server: ServerState) {
  const { registry, runtime, generatedApi } = server;
  const settings = useAtomValue(() => server.preferences.value);
  const appearance = () => settings().appearance;
  const settingsOpen = useAtomValue(
    () => server.workspacePanelState,
    (state) => state.settingsOpen,
  );
  const setSettingsOpenCommand = runtime.fn(
    (open: boolean) =>
      Effect.sync(() =>
        registry.update(server.workspacePanelState, (state) => ({ ...state, settingsOpen: open })),
      ),
    { concurrent: true },
  );
  const administrator = Atom.make<{
    revision: number;
    settings?: ServerRuntimeSettings;
    roots: LibraryRoot[];
    notice: string;
    uncertainRescanKey?: string;
    operation?: "load" | "save" | "rescan";
  }>({ revision: 0, roots: [], notice: "" }).pipe(Atom.keepAlive);
  const administratorValue = useAtomValue(() => administrator);
  const runtimeSettings = () => administratorValue().settings;
  const libraryRoots = () => administratorValue().roots;
  const settingsRevision = () => administratorValue().revision;
  const publishSettings = (
    value: Pick<GeneratedSettingsResponse, "revision" | "settings"> &
      Partial<Pick<GeneratedSettingsResponse, "roots">>,
    notice: string,
  ) => {
    if (disposed) return;
    registry.update(administrator, (current) => ({
      ...current,
      revision: value.revision,
      settings: {
        ...value.settings,
        destinations: value.settings.destinations?.map((destination) => ({ ...destination })),
      },
      roots: value.roots
        ? Object.entries(value.roots).map(([alias, root]) => ({ alias, ...root }))
        : current.roots,
      notice,
    }));
  };
  const mcp = Atom.make<{
    data?: MCPSettings;
    notice: string;
    session: number;
    actionSession?: number;
  }>({
    notice: "",
    session: 0,
  }).pipe(Atom.keepAlive);
  // Disclosure is deliberately separate from preferences and secret-free command outcomes.
  const disclosure = Atom.make("").pipe(Atom.keepAlive);
  const mcpValue = useAtomValue(() => mcp);
  const mcpSettings = () => mcpValue().data;
  const revealedMCPSecret = useAtomValue(() => disclosure);
  const mcpDraft = Atom.make({
    name: "",
    permissions: [] as string[],
    expiry: "7d",
    nonExpiringAcknowledged: false,
    mediaScope: "all",
    rootIDs: [] as string[],
    mediaIDs: "",
    projectScope: "all",
    projectIDs: "",
    unattendedExports: false,
  }).pipe(Atom.keepAlive);
  const mcpDraftValue = useAtomValue(() => mcpDraft);
  const editMCPDraft = runtime.fn(
    (changes: Partial<ReturnType<typeof mcpDraftValue>>) =>
      Effect.sync(() => {
        if (!disposed) registry.update(mcpDraft, (current) => ({ ...current, ...changes }));
      }),
    { concurrent: true },
  );
  const updateMCPDraft = <K extends keyof ReturnType<typeof mcpDraftValue>>(
    key: K,
    value:
      | ReturnType<typeof mcpDraftValue>[K]
      | ((current: ReturnType<typeof mcpDraftValue>[K]) => ReturnType<typeof mcpDraftValue>[K]),
  ) => {
    if (!disposed)
      registry.set(editMCPDraft, {
        [key]: typeof value === "function" ? value(registry.get(mcpDraft)[key]) : value,
      });
  };
  let disposed = false;
  const releases: Array<() => void> = [];

  function generatedQuery<A, E>(
    atom: Atom.Atom<AsyncResult.AsyncResult<A, E>>,
  ): Effect.Effect<A, E> {
    return Effect.acquireUseRelease(
      Effect.sync(() => {
        const current = registry.get(atom);
        const release = registry.mount(atom);
        if (AsyncResult.isNotInitial(current)) registry.refresh(atom);
        return release;
      }),
      () => AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true }),
      (release) => Effect.sync(release),
    );
  }

  const settingsLoad = runtime.fn(() =>
    Effect.sync(() => {
      registry.update(administrator, (current) => ({
        ...current,
        settings: undefined,
        roots: [],
        notice: "",
        operation: "load" as const,
      }));
    }).pipe(
      Effect.andThen(generatedQuery(generatedApi.query("default", "getSettings", {}))),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(Cause.squash(cause)),
      ),
      Effect.mapError(
        (error) =>
          new Error(
            apiErrorCode(error) === "origin_forbidden"
              ? originMessage
              : "Administrator settings are unavailable on this server. Check your access and retry.",
          ),
      ),
      Effect.tap((value) =>
        Effect.sync(() => publishSettings(value, "Administrator settings loaded.")),
      ),
    ),
  );
  const settingsLoadResult = useAtomValue(() => settingsLoad);

  const mcpLoad = runtime.fn((args: { cursor?: string; proposalCursor?: string }) =>
    generatedQuery(
      generatedApi.query("default", "getMCPSettings", {
        query: {
          ...(args.cursor ? { cursor: args.cursor } : {}),
          ...(args.proposalCursor
            ? { proposalCursor: args.proposalCursor, proposalLimit: 25 }
            : {}),
        },
      }),
    ).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => ({
            ...value,
            endpoint: new URL(value.endpoint, api.url("settings")).toString(),
          }),
          catch: () => new Error(mcpRefreshMessage),
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.fail(new Error(mcpRefreshMessage)),
      ),
      Effect.mapError(() => new Error(mcpRefreshMessage)),
      Effect.tap((value) =>
        Effect.sync(() => {
          if (!disposed) mergeMCP(value, args.cursor, args.proposalCursor);
        }),
      ),
    ),
  );
  const mcpLoadResult = useAtomValue(() => mcpLoad);
  const settingsSave = runtime.fn(
    (action: { changes: Partial<ServerRuntimeSettings>; successMessage: string }) =>
      Effect.gen(function* () {
        registry.update(administrator, (current) => ({ ...current, operation: "save" as const }));
        const current = registry.get(administrator);
        const candidate = { ...current.settings, ...action.changes };
        if (!current.settings || !validRuntimeSettingsInput(candidate))
          return yield* Effect.fail(
            new Error(
              "Use complete positive whole-number limits, export concurrency 1–64, and a maximum preview window covering before + after. Reload settings if values are missing.",
            ),
          );
        const saved = yield* runServerMutation(
          registry,
          generatedApi.mutation("default", "updateSettings"),
          {
            payload: { revision: current.revision, settings: candidate },
          },
        ).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(Cause.squash(cause)),
          ),
          Effect.mapError(
            (error) =>
              new Error(
                apiErrorCode(error) === "settings_revision_conflict"
                  ? "Settings changed; reload before updating."
                  : apiErrorCode(error) === "invalid_settings" ||
                      apiErrorCode(error) === "deployment_settings_read_only"
                    ? "Settings were rejected. Check the configured limits; deployment settings are read-only."
                    : apiErrorCode(error) === "origin_forbidden"
                      ? originMessage
                      : "Settings could not be saved. Retry or reload to check the server state.",
              ),
          ),
        );
        publishSettings(
          { revision: saved.revision, settings: saved.settings },
          action.successMessage,
        );
        return true;
      }),
  );
  const settingsSaveResult = useAtomValue(() => settingsSave);
  type MCPMutation =
    | { type: "create"; input: MCPCredentialCreate; session: number }
    | { type: "approve"; id: string }
    | { type: "revoke"; id: string };
  type MCPMutationOutcome =
    | { type: "create" }
    | { type: "approve"; proposalId: string }
    | { type: "revoke" };
  const mcpMutation = runtime.fn((action: MCPMutation, get) =>
    Effect.gen(function* () {
      let outcome: MCPMutationOutcome;
      switch (action.type) {
        case "create": {
          const mutation = generatedApi.mutation("default", "createMCPCredential");
          yield* runServerMutation(registry, mutation, { payload: action.input }).pipe(
            Effect.mapError(() => new Error("Credential settings were rejected.")),
            Effect.tap((created) =>
              Effect.sync(() => {
                if (!disposed && settingsOpen() && action.session === registry.get(mcp).session)
                  registry.set(disclosure, created.secret);
              }),
            ),
          );
          // Never retain the one-time secret in an atom result or registry cache.
          if (!disposed && action.session === registry.get(mcp).session)
            registry.update(mcpDraft, (current) => ({
              ...current,
              name: "",
              permissions: [],
              unattendedExports: false,
            }));
          outcome = { type: "create" };
          break;
        }
        case "approve": {
          const mutation = generatedApi.mutation("default", "approveExportProposal");
          const approved = yield* runServerMutation(registry, mutation, {
            params: { proposalId: action.id },
          }).pipe(Effect.mapError(() => new Error("Export proposal could not be approved.")));
          outcome = { type: "approve", proposalId: approved.id };
          break;
        }
        case "revoke": {
          const mutation = generatedApi.mutation("default", "revokeMCPCredential");
          yield* runServerMutation(registry, mutation, {
            params: { credentialId: action.id },
          }).pipe(Effect.mapError(() => new Error("Credential could not be revoked.")));
          outcome = { type: "revoke" };
          break;
        }
      }
      // A failed refresh must not turn a completed mutation into a retryable mutation.
      yield* get.setResult(mcpLoad, {}).pipe(Effect.catch(() => Effect.succeed(undefined)));
      if (!disposed && settingsOpen())
        registry.update(mcp, (current) => ({
          ...current,
          notice:
            outcome.type === "create"
              ? action.type === "create" && action.session === current.session
                ? "MCP credential created. Copy the secret now; it will not be shown again."
                : "MCP credential created. Secret disclosure was dismissed; revoke and recreate if needed."
              : outcome.type === "approve"
                ? `Export proposal ${outcome.proposalId} approved.`
                : "MCP credential revoked.",
        }));
      return outcome;
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.fail(
              new Error(
                action.type === "create"
                  ? "Credential settings were rejected."
                  : action.type === "approve"
                    ? "Export proposal could not be approved."
                    : "Credential could not be revoked.",
              ),
            ),
      ),
    ),
  );
  const mcpMutationResult = useAtomValue(() => mcpMutation);
  const mcpStatus = () =>
    settingsOpen()
      ? mcpValue().notice ||
        (mcpValue().actionSession === mcpValue().session
          ? serverResultError(mcpMutationResult())?.message
          : "") ||
        ""
      : "";
  const rescan = runtime.fn(() =>
    Effect.gen(function* () {
      registry.update(administrator, (current) => ({ ...current, operation: "rescan" as const }));
      const key = registry.get(administrator).uncertainRescanKey ?? globalThis.crypto.randomUUID();
      yield* runServerMutation(registry, generatedApi.mutation("default", "refreshSettingsMedia"), {
        headers: { "Idempotency-Key": key },
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause) ? Effect.failCause(cause) : Effect.fail(Cause.squash(cause)),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (!disposed)
              registry.update(administrator, (current) => ({
                ...current,
                uncertainRescanKey: isUncertainRequestError(error) ? key : undefined,
              }));
          }),
        ),
        Effect.mapError(
          (error) =>
            new Error("Media library could not be rescanned. Check mounts and permissions.", {
              cause: error,
            }),
        ),
      );
      if (!disposed)
        registry.update(administrator, (current) => ({
          ...current,
          uncertainRescanKey: undefined,
          notice: "Media library rescan started.",
        }));
    }),
  );
  const rescanResult = useAtomValue(() => rescan);
  const serverSettingsStatus = () => {
    const operation = administratorValue().operation;
    const result =
      operation === "load"
        ? settingsLoadResult()
        : operation === "save"
          ? settingsSaveResult()
          : rescanResult();
    if (result.waiting)
      return operation === "load"
        ? "Loading administrator settings…"
        : operation === "save"
          ? "Saving administrator settings…"
          : "Rescanning media library…";
    return serverResultError(result)?.message ?? administratorValue().notice;
  };
  const serverSettingsLoading = () => settingsLoadResult().waiting;
  const settingsPending = () => settingsSaveResult().waiting;
  const mcpLoading = () => mcpLoadResult().waiting;
  const mcpPending = () => mcpMutationResult().waiting;
  const rescanPending = () => rescanResult().waiting;
  const mcpLoadError = () => serverResultError(mcpLoadResult())?.message ?? "";
  function ownCommand<Arg, A>(command: Atom.AtomResultFn<Arg, A, Error>) {
    const release = registry.mount(command);
    releases.push(() => {
      registry.set(command, Atom.Interrupt);
      release();
    });
  }
  ownCommand(settingsLoad);
  ownCommand(settingsSave);
  ownCommand(rescan);
  ownCommand(mcpLoad);
  ownCommand(mcpMutation);
  ownCommand(editMCPDraft);
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    registry.set(disclosure, "");
    registry.update(mcp, (current) => ({ ...current, session: current.session + 1, notice: "" }));
    for (const release of releases) release();
  };
  if (getOwner()) onCleanup(dispose);

  function mergeMCP(value: MCPSettings, cursor?: string, proposalCursor?: string) {
    registry.update(mcp, (state) => {
      const current = state.data;
      return {
        ...state,
        data: {
          ...value,
          credentials: cursor
            ? [...(current?.credentials ?? []), ...value.credentials]
            : proposalCursor
              ? (current?.credentials ?? value.credentials)
              : value.credentials,
          nextCursor: cursor
            ? value.nextCursor
            : proposalCursor
              ? current?.nextCursor
              : value.nextCursor,
          proposals: proposalCursor
            ? [...(current?.proposals ?? []), ...value.proposals]
            : cursor
              ? (current?.proposals ?? value.proposals)
              : value.proposals,
          proposalNextCursor: proposalCursor
            ? value.proposalNextCursor
            : cursor
              ? current?.proposalNextCursor
              : value.proposalNextCursor,
          endpoint: value.endpoint,
        },
      };
    });
  }
  const setSettingsOpen = (open: boolean) => {
    if (disposed) return false;
    registry.set(setSettingsOpenCommand, open);
    if (!open) {
      registry.update(mcp, (current) => ({ ...current, session: current.session + 1, notice: "" }));
      registry.set(disclosure, "");
    }
    return open;
  };

  const updatePreferences = runtime.fn(
    (update: { type: "merge"; changes: Partial<BrowserPreferences> } | { type: "reset" }) =>
      AtomRegistry.getResult(registry, server.preferences.initialize, {
        suspendOnWaiting: true,
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (disposed) return;
            const next =
              update.type === "reset"
                ? defaultBrowserPreferences
                : { ...registry.get(server.preferences.value), ...update.changes };
            registry.set(server.preferences.value, next);
          }),
        ),
      ),
    { concurrent: true },
  );
  ownCommand(updatePreferences);
  const saveSettings = (changes: Partial<BrowserPreferences>) => {
    if (
      (changes.filenameTemplate !== undefined &&
        !validFilenameTemplateLength(changes.filenameTemplate)) ||
      (changes.lastDestinationId !== undefined && !validDestinationId(changes.lastDestinationId))
    )
      return;
    registry.set(updatePreferences, { type: "merge", changes });
  };
  const resetBrowserPreferences = () => registry.set(updatePreferences, { type: "reset" });
  const loadServerSettings = () => {
    if (!disposed && !settingsPending()) registry.set(settingsLoad, undefined);
  };
  const loadMCPSettings = (cursor?: string, proposalCursor?: string) => {
    if (mcpLoading() || mcpPending() || settingsPending() || disposed) return false;
    registry.set(mcpLoad, { cursor, proposalCursor });
    return true;
  };
  const open = runtime.fn((_, get) =>
    Effect.all(
      [
        get.setResult(settingsLoad, undefined).pipe(Effect.catch(() => Effect.void)),
        get.setResult(mcpLoad, {}).pipe(Effect.catch(() => Effect.void)),
      ],
      { concurrency: "unbounded" },
    ),
  );
  const releaseOpen = registry.mount(open);
  releases.push(() => {
    registry.set(open, Atom.Interrupt);
    releaseOpen();
  });
  const openSettings = () => {
    if (disposed) return;
    setSettingsOpen(true);
    if (settingsPending() || mcpPending() || mcpLoading()) return;
    registry.set(open, undefined);
  };
  const saveRuntimeSettings = (changes: Partial<ServerRuntimeSettings>, successMessage: string) => {
    if (!disposed && !settingsPending() && !serverSettingsLoading())
      registry.set(settingsSave, { changes, successMessage });
  };
  const mcpEnable = runtime.fn((enabled: boolean, get) =>
    get
      .setResult(settingsSave, {
        changes: { mcpEnabled: enabled },
        successMessage: `MCP ${enabled ? "enabled" : "disabled"}.`,
      })
      .pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (!disposed)
              registry.update(mcp, (current) => ({
                ...current,
                data: current.data
                  ? { ...current.data, enabled: registry.get(administrator).settings!.mcpEnabled }
                  : undefined,
              }));
          }),
        ),
      ),
  );
  ownCommand(mcpEnable);
  const setMCPEnabled = (enabled: boolean) => {
    if (disposed || mcpLoading() || mcpPending() || settingsPending() || serverSettingsLoading())
      return false;
    registry.set(mcpEnable, enabled);
    return true;
  };
  const dispatchMCP = (action: MCPMutation) => {
    if (mcpPending() || mcpLoading() || settingsPending() || disposed) return false;
    registry.update(mcp, (current) => ({ ...current, notice: "", actionSession: current.session }));
    registry.set(mcpMutation, action);
    return true;
  };
  const createMCPCredential = (input: MCPCredentialCreate) => {
    if (mcpPending() || mcpLoading() || settingsPending() || disposed) return false;
    registry.set(disclosure, "");
    return dispatchMCP({ type: "create", input, session: registry.get(mcp).session });
  };
  const approveExportProposal = (id: string) => dispatchMCP({ type: "approve", id });
  const revokeMCPCredential = (id: string) => dispatchMCP({ type: "revoke", id });
  const rescanLibrary = () => {
    if (!disposed && !rescanPending()) registry.set(rescan, undefined);
  };

  return {
    settings,
    appearance,
    settingsOpen,
    setSettingsOpen,
    serverSettingsStatus,
    libraryRoots,
    settingsRevision,
    runtimeSettings,
    administrator,
    settingsLoad,
    settingsSave,
    rescan,
    settingsPending,
    dispose,
    serverSettingsLoading,
    rescanPending,
    mcpDraftValue,
    updateMCPDraft,
    mcp,
    disclosure,
    mcpLoad,
    mcpMutation,
    mcpEnable,
    mcpSettings,
    mcpStatus,
    mcpLoadError,
    mcpLoading,
    loadMCPSettings,
    mcpPending,
    revealedMCPSecret,
    saveSettings,
    resetBrowserPreferences,
    loadServerSettings,
    openSettings,
    saveRuntimeSettings,
    setMCPEnabled,
    createMCPCredential,
    approveExportProposal,
    revokeMCPCredential,
    rescanLibrary,
  };
}
