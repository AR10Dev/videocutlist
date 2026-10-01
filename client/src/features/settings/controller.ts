import { Cause, Effect, Layer } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createSignal, getOwner, onCleanup, type Accessor, type Setter } from "solid-js";
import { ApiFailure, apiJson, apiRequest, runEffect, type ApiClient } from "../../api";
import type { components } from "../../generated/api";
import type { ServerState } from "../app/server";
import {
  validFilenameTemplateLength,
  settingsKey,
  storedSettings,
  validRuntimeSettingsInput,
  type AppSettings,
  type Appearance,
} from "./model";

type LibraryRoot = {
  alias: string;
  state?: "ready" | "unavailable";
  message?: string;
};
type ServerRuntimeSettings = components["schemas"]["RuntimeSettings"];
type ServerSettings = components["schemas"]["SettingsResponse"];
type MCPSettings = components["schemas"]["MCPSettingsResponse"];
type MCPCredentialCreate = components["schemas"]["MCPCredentialCreate"];
type MCPCredentialCreated = components["schemas"]["MCPCredentialCreated"];
type ExportProposal = components["schemas"]["ExportProposal"];

const originMessage =
  "This browser origin is not allowed by the server. Check the deployment CORS settings.";
const mcpRefreshMessage =
  "MCP settings could not be refreshed. Displayed data may be outdated. Retry refresh.";

function publicError(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function resultError<A>(result: AsyncResult.AsyncResult<A, Error>): Error | undefined {
  if (!AsyncResult.isFailure(result)) return;
  const error = Cause.squash(result.cause);
  return error instanceof Error ? error : new Error("Request could not be completed.");
}

export function createSettingsController(api: ApiClient, server?: ServerState) {
  const registry = server?.registry ?? AtomRegistry.make();
  const runtime = server?.runtime ?? Atom.runtime(Layer.empty);
  const [settings, setSettings] = createSignal(storedSettings());
  const [appearance, setAppearance] = createSignal<Appearance>(settings().appearance);
  const [settingsOpen, setOpen] = createSignal(false);
  const [serverSettingsStatus, setServerSettingsStatus] = createSignal("");
  const [libraryRoots, setLibraryRoots] = createSignal<LibraryRoot[]>([]);
  const [settingsRevision, setSettingsRevision] = createSignal(0);
  const [runtimeSettings, setRuntimeSettings] = createSignal<ServerRuntimeSettings>();
  const [mcpSettings, setMCPSettings] = createSignal<MCPSettings>();
  const [revealedMCPSecret, setRevealedMCPSecret] = createSignal("");
  const [mcpStatus, setMCPStatus] = createSignal("");
  let disclosureSession = 0;
  let disposed = false;

  // A single native result is the source of truth; subscriptions only expose it
  // to Solid's synchronous accessors (including controllers created without an owner).
  const releases: Array<() => void> = [];
  function observe<A, Arg>(
    atom: Atom.AtomResultFn<Arg, A, Error>,
  ): Accessor<AsyncResult.AsyncResult<A, Error>> {
    const [value, setValue] = createSignal(registry.get(atom));
    const unmount = registry.mount(atom);
    const unsubscribe = registry.subscribe(atom, setValue, { immediate: true });
    releases.push(() => {
      registry.set(atom, Atom.Interrupt);
      unsubscribe();
      unmount();
    });
    return value;
  }

  const settingsLoad = runtime.fn(() =>
    apiJson<ServerSettings>(api, "settings").pipe(
      Effect.mapError(
        (error) =>
          new Error(
            error instanceof ApiFailure && error.code === "origin_forbidden"
              ? originMessage
              : "Administrator settings are unavailable on this server. Check your access and retry.",
          ),
      ),
    ),
  );
  const settingsLoadResult = observe(settingsLoad);
  const mcpLoad = runtime.fn((args: { cursor?: string; proposalCursor?: string }) => {
    const query = new URLSearchParams();
    if (args.cursor) query.set("cursor", args.cursor);
    if (args.proposalCursor) {
      query.set("proposalCursor", args.proposalCursor);
      query.set("proposalLimit", "25");
    }
    return apiJson<MCPSettings>(api, `settings/mcp${query.size ? `?${query}` : ""}`).pipe(
      Effect.flatMap((value) =>
        Effect.try({
          try: () => ({
            ...value,
            endpoint: new URL(value.endpoint, api.url("settings")).toString(),
          }),
          catch: () => new Error(mcpRefreshMessage),
        }),
      ),
      Effect.mapError(() => new Error(mcpRefreshMessage)),
    );
  });
  const mcpLoadResult = observe(mcpLoad);
  const settingsSave = runtime.fn((input: components["schemas"]["SettingsUpdate"]) =>
    apiJson<components["schemas"]["SettingsUpdated"]>(api, "settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }).pipe(
      Effect.mapError(
        (error) =>
          new Error(
            error instanceof ApiFailure
              ? error.code === "settings_revision_conflict"
                ? "Settings changed; reload before updating."
                : error.code === "invalid_settings" ||
                    error.code === "deployment_settings_read_only"
                  ? "Settings were rejected. Check the configured limits; deployment settings are read-only."
                  : error.code === "origin_forbidden"
                    ? originMessage
                    : "Settings could not be saved. Retry or reload to check the server state."
              : "Settings could not be saved. Retry or reload to check the server state.",
          ),
      ),
    ),
  );
  const settingsSaveResult = observe(settingsSave);
  type MCPMutation =
    | { type: "create"; input: MCPCredentialCreate; session: number }
    | { type: "approve"; id: string }
    | { type: "revoke"; id: string };
  type MCPMutationOutcome =
    | { type: "create" }
    | { type: "approve"; approved: ExportProposal }
    | { type: "revoke" };
  const mcpMutation = runtime.fn((action: MCPMutation, get) =>
    Effect.gen(function* () {
      let outcome: MCPMutationOutcome;
      switch (action.type) {
        case "create": {
          yield* apiJson<MCPCredentialCreated>(api, "settings/mcp/credentials", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(action.input),
          }).pipe(
            Effect.mapError(() => new Error("Credential settings were rejected.")),
            Effect.tap((created) =>
              Effect.sync(() => {
                if (!disposed && settingsOpen() && action.session === disclosureSession)
                  setRevealedMCPSecret(created.secret);
              }),
            ),
          );
          // Never retain the one-time secret in an atom result or registry cache.
          outcome = { type: "create" };
          break;
        }
        case "approve": {
          const approved = yield* apiJson<ExportProposal>(
            api,
            `export-proposals/${encodeURIComponent(action.id)}/approval`,
            { method: "POST" },
          ).pipe(Effect.mapError(() => new Error("Export proposal could not be approved.")));
          outcome = { type: "approve", approved };
          break;
        }
        case "revoke":
          yield* apiRequest(api, `settings/mcp/credentials/${encodeURIComponent(action.id)}`, {
            method: "DELETE",
          }).pipe(
            Effect.flatMap((response) =>
              response.ok
                ? Effect.succeed(undefined)
                : Effect.fail(new Error("Credential could not be revoked.")),
            ),
            Effect.mapError(() => new Error("Credential could not be revoked.")),
          );
          outcome = { type: "revoke" };
          break;
      }
      // A failed refresh must not turn a completed mutation into a retryable mutation.
      yield* get.setResult(mcpLoad, {}).pipe(
        Effect.tap((value) => Effect.sync(() => mergeMCP(value))),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      return outcome;
    }),
  );
  const mcpMutationResult = observe(mcpMutation);
  const rescan = runtime.fn(() =>
    apiRequest(api, "settings/media/refresh", {
      method: "POST",
    }).pipe(
      Effect.flatMap((response) =>
        response.ok
          ? Effect.succeed(undefined)
          : Effect.fail(
              new Error("Media library could not be rescanned. Check mounts and permissions."),
            ),
      ),
      Effect.mapError(
        () => new Error("Media library could not be rescanned. Check mounts and permissions."),
      ),
    ),
  );
  const rescanResult = observe(rescan);
  const serverSettingsLoading = () => settingsLoadResult().waiting;
  const settingsPending = () => settingsSaveResult().waiting;
  const mcpLoading = () => mcpLoadResult().waiting;
  const mcpPending = () => mcpMutationResult().waiting;
  const rescanPending = () => rescanResult().waiting;
  const mcpLoadError = () => resultError(mcpLoadResult())?.message ?? "";
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    disclosureSession++;
    for (const release of releases) release();
    if (!server) registry.dispose();
  };
  if (getOwner()) onCleanup(dispose);

  async function execute<Arg, A>(command: Atom.AtomResultFn<Arg, A, Error>, arg: Arg): Promise<A> {
    registry.set(command, arg);
    return runEffect(AtomRegistry.getResult(registry, command, { suspendOnWaiting: true }));
  }

  function mergeMCP(value: MCPSettings, cursor?: string, proposalCursor?: string) {
    setMCPSettings((current) => ({
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
    }));
  }
  const setSettingsOpen: Setter<boolean> = (value) => {
    const next = setOpen(value);
    if (!next) {
      disclosureSession++;
      setRevealedMCPSecret("");
      setMCPStatus("");
    }
    return next;
  };

  const saveSettings = (changes: Partial<AppSettings>) => {
    if (
      changes.filenameTemplate !== undefined &&
      !validFilenameTemplateLength(changes.filenameTemplate)
    )
      return;
    const next = { ...settings(), ...changes };
    setSettings(next);
    setAppearance(next.appearance);
    try {
      globalThis.localStorage?.setItem(settingsKey, JSON.stringify(next));
    } catch {
      // Browser preferences remain usable for this session when storage is disabled.
    }
  };
  let loadVersion = 0;
  const loadServerSettings = async () => {
    if (settingsPending() || disposed) return;
    const version = ++loadVersion;
    setRuntimeSettings();
    setLibraryRoots([]);
    setServerSettingsStatus("Loading administrator settings…");
    try {
      const value = await execute(settingsLoad, undefined);
      if (disposed || version !== loadVersion) return;
      setLibraryRoots(
        Object.entries(value.roots ?? {}).map(([alias, root]) => ({ alias, ...root })),
      );
      setSettingsRevision(value.revision);
      setRuntimeSettings(value.settings);
      setServerSettingsStatus("Administrator settings loaded.");
    } catch (error) {
      if (disposed || version !== loadVersion) return;
      setServerSettingsStatus(
        publicError(error, "Administrator settings are unavailable on this server."),
      );
    }
  };
  const loadMCPSettings = async (cursor?: string, proposalCursor?: string) => {
    if (mcpLoading() || mcpPending() || settingsPending() || disposed) return false;
    try {
      const value = await execute(mcpLoad, { cursor, proposalCursor });
      if (disposed) return false;
      mergeMCP(value, cursor, proposalCursor);
      return true;
    } catch {
      return false;
    }
  };
  const openSettings = async () => {
    setSettingsOpen(true);
    await Promise.all([loadServerSettings(), loadMCPSettings()]);
  };
  const saveRuntimeSettings = async (
    changes: Partial<ServerRuntimeSettings>,
    successMessage: string,
  ) => {
    if (settingsPending() || serverSettingsLoading()) return false;
    const candidate = { ...runtimeSettings(), ...changes };
    if (!runtimeSettings() || !validRuntimeSettingsInput(candidate)) {
      setServerSettingsStatus(
        "Use complete positive whole-number limits, export concurrency 1–64, and a maximum preview window covering before + after. Reload settings if values are missing.",
      );
      return false;
    }
    const input: components["schemas"]["SettingsUpdate"] = {
      revision: settingsRevision(),
      settings: candidate,
    };
    setServerSettingsStatus("Saving administrator settings…");
    try {
      const saved = await execute(settingsSave, input);
      if (disposed) return false;
      setSettingsRevision(saved.revision);
      setRuntimeSettings(saved.settings);
      setServerSettingsStatus(successMessage);
      return true;
    } catch (error) {
      if (!disposed) setServerSettingsStatus(publicError(error, "Settings could not be saved."));
      return false;
    }
  };
  const setMCPEnabled = async (enabled: boolean) => {
    if (mcpLoading() || mcpPending()) return false;
    if (
      await saveRuntimeSettings({ mcpEnabled: enabled }, `MCP ${enabled ? "enabled" : "disabled"}.`)
    ) {
      setMCPSettings((current) => (current ? { ...current, enabled } : current));
      return true;
    }
    return false;
  };
  const createMCPCredential = async (input: MCPCredentialCreate) => {
    if (mcpPending() || mcpLoading() || disposed) return false;
    setRevealedMCPSecret("");
    const session = disclosureSession;
    try {
      const result = await execute(mcpMutation, { type: "create", input, session });
      if (disposed || result.type !== "create") return false;
      // Closing while the request is running permanently dismisses this disclosure.
      if (settingsOpen() && session === disclosureSession)
        setMCPStatus("MCP credential created. Copy the secret now; it will not be shown again.");
      else if (settingsOpen())
        setMCPStatus(
          "MCP credential created. Secret disclosure was dismissed; revoke and recreate if needed.",
        );
      return true;
    } catch (error) {
      if (!disposed && settingsOpen() && session === disclosureSession)
        setMCPStatus(publicError(error, "Credential could not be created."));
      return false;
    }
  };
  const approveExportProposal = async (proposalId: string) => {
    if (mcpPending() || mcpLoading() || disposed) return false;
    try {
      const result = await execute(mcpMutation, { type: "approve", id: proposalId });
      if (disposed || result.type !== "approve") return false;
      setMCPStatus(`Export proposal ${result.approved.id} approved.`);
      return true;
    } catch (error) {
      if (!disposed) setMCPStatus(publicError(error, "Export proposal could not be approved."));
      return false;
    }
  };
  const revokeMCPCredential = async (credentialId: string) => {
    if (mcpPending() || mcpLoading() || disposed) return;
    try {
      await execute(mcpMutation, { type: "revoke", id: credentialId });
      if (!disposed) setMCPStatus("MCP credential revoked.");
    } catch (error) {
      if (!disposed) setMCPStatus(publicError(error, "Credential could not be revoked."));
    }
  };
  const rescanLibrary = async () => {
    if (rescanPending() || disposed) return;
    setServerSettingsStatus("Rescanning media library…");
    try {
      await execute(rescan, undefined);
      if (!disposed) setServerSettingsStatus("Media library rescan started.");
    } catch (error) {
      if (!disposed) setServerSettingsStatus(publicError(error, "Media library rescan failed."));
    }
  };

  return {
    settings,
    setSettings,
    appearance,
    setAppearance,
    settingsOpen,
    setSettingsOpen,
    serverSettingsStatus,
    setServerSettingsStatus,
    libraryRoots,
    setLibraryRoots,
    settingsRevision,
    setSettingsRevision,
    runtimeSettings,
    setRuntimeSettings,
    settingsPending,
    dispose,
    serverSettingsLoading,
    rescanPending,
    mcpSettings,
    mcpStatus,
    mcpLoadError,
    mcpLoading,
    loadMCPSettings,
    mcpPending,
    revealedMCPSecret,
    saveSettings,
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
