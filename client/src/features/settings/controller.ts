import { createSignal, type Setter } from "solid-js";
import { readApiError, type ApiClient } from "../../api";
import type { components } from "../../generated/api";
import {
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

export function createSettingsController(api: ApiClient) {
  const [settings, setSettings] = createSignal(storedSettings(localStorage));
  const [appearance, setAppearance] = createSignal<Appearance>(settings().appearance);
  const [settingsOpen, setOpen] = createSignal(false);
  const [serverSettingsStatus, setServerSettingsStatus] = createSignal("");
  const [libraryRoots, setLibraryRoots] = createSignal<LibraryRoot[]>([]);
  const [settingsRevision, setSettingsRevision] = createSignal(0);
  const [runtimeSettings, setRuntimeSettings] = createSignal<ServerRuntimeSettings>();
  const [settingsPending, setSettingsPending] = createSignal(false);
  const [serverSettingsLoading, setServerSettingsLoading] = createSignal(false);
  let settingsRequest: AbortController | undefined;
  const [rescanPending, setRescanPending] = createSignal(false);
  const [mcpSettings, setMCPSettings] = createSignal<MCPSettings>();
  const [mcpPending, setMCPPending] = createSignal(false);
  const [revealedMCPSecret, setRevealedMCPSecret] = createSignal("");

  const [mcpStatus, setMCPStatus] = createSignal("");
  const [mcpLoadError, setMCPLoadError] = createSignal("");
  const [mcpLoading, setMCPLoading] = createSignal(false);
  let disclosureSession = 0;
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
    const next = { ...settings(), ...changes };
    setSettings(next);
    setAppearance(next.appearance);
    localStorage.setItem(settingsKey, JSON.stringify(next));
  };
  const loadServerSettings = async () => {
    if (settingsPending()) return;
    settingsRequest?.abort();
    const controller = new AbortController();
    settingsRequest = controller;
    setServerSettingsLoading(true);
    setRuntimeSettings();
    setLibraryRoots([]);
    setServerSettingsStatus("Loading administrator settings…");
    try {
      const response = await api.request("settings", { signal: controller.signal });
      if (!response.ok) {
        const error = await readApiError(response);
        throw new Error(
          error.code === "origin_forbidden"
            ? "This browser origin is not allowed by the server. Check the deployment CORS settings."
            : "Administrator settings are unavailable on this server. Check your access and retry.",
        );
      }
      const value = (await response.json()) as ServerSettings;
      if (controller.signal.aborted) return;
      setLibraryRoots(
        Object.entries(value.roots ?? {}).map(([alias, root]) => ({ alias, ...root })),
      );
      setSettingsRevision(value.revision);
      setRuntimeSettings(value.settings);
      setServerSettingsStatus("Administrator settings loaded.");
    } catch (error) {
      if (controller.signal.aborted) return;
      setServerSettingsStatus(
        error instanceof Error
          ? error.message
          : "Administrator settings are unavailable on this server.",
      );
    } finally {
      if (settingsRequest === controller) setServerSettingsLoading(false);
    }
  };
  const loadMCPSettings = async (cursor?: string, proposalCursor?: string) => {
    if (mcpLoading() || settingsPending()) return false;
    setMCPLoading(true);
    setMCPLoadError("");
    try {
      const query = new URLSearchParams();
      if (cursor) query.set("cursor", cursor);
      if (proposalCursor) {
        query.set("proposalCursor", proposalCursor);
        query.set("proposalLimit", "25");
      }
      const suffix = query.toString() ? `?${query}` : "";
      const response = await api.request(`settings/mcp${suffix}`);
      if (!response.ok)
        throw new Error(
          "MCP settings could not be refreshed. Displayed data may be outdated. Retry refresh.",
        );
      const value = (await response.json()) as MCPSettings;
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
        endpoint: new URL(value.endpoint, api.url("settings")).toString(),
      }));
      return true;
    } catch (error) {
      setMCPLoadError(
        error instanceof Error
          ? error.message
          : "MCP settings could not be refreshed. Retry refresh.",
      );
      return false;
    } finally {
      setMCPLoading(false);
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
    setSettingsPending(true);
    setServerSettingsStatus("Saving administrator settings…");
    try {
      const response = await api.request("settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) {
        const error = await readApiError(response);
        throw new Error(
          error.code === "settings_revision_conflict"
            ? "Settings changed; reload before updating."
            : error.code === "invalid_settings" || error.code === "deployment_settings_read_only"
              ? "Settings were rejected. Check the configured limits; deployment settings are read-only."
              : error.code === "origin_forbidden"
                ? "This browser origin is not allowed by the server. Check the deployment CORS settings."
                : "Settings could not be saved. Retry or reload to check the server state.",
        );
      }
      const saved = (await response.json()) as components["schemas"]["SettingsUpdated"];
      setSettingsRevision(saved.revision);
      setRuntimeSettings(saved.settings);
      setServerSettingsStatus(successMessage);
      return true;
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Settings could not be saved.",
      );
      return false;
    } finally {
      setSettingsPending(false);
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
    if (mcpPending() || mcpLoading()) return false;
    setMCPPending(true);
    setRevealedMCPSecret("");
    const session = disclosureSession;
    try {
      const response = await api.request("settings/mcp/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("Credential settings were rejected.");
      const created = (await response.json()) as MCPCredentialCreated;
      if (settingsOpen() && session === disclosureSession) setRevealedMCPSecret(created.secret);
      await loadMCPSettings();
      setMCPStatus(
        revealedMCPSecret()
          ? "MCP credential created. Copy the secret now; it will not be shown again."
          : "MCP credential created. Secret disclosure was dismissed; revoke and recreate if needed.",
      );
      return true;
    } catch (error) {
      setMCPStatus(error instanceof Error ? error.message : "Credential could not be created.");
      return false;
    } finally {
      setMCPPending(false);
    }
  };
  const approveExportProposal = async (proposalId: string) => {
    if (mcpPending() || mcpLoading()) return false;
    setMCPPending(true);
    try {
      const response = await api.request(
        `export-proposals/${encodeURIComponent(proposalId)}/approval`,
        {
          method: "POST",
        },
      );
      if (!response.ok) throw new Error("Export proposal could not be approved.");
      const approved = (await response.json()) as ExportProposal;
      await loadMCPSettings();
      setMCPStatus(`Export proposal ${approved.id} approved.`);
      return true;
    } catch (error) {
      setMCPStatus(
        error instanceof Error ? error.message : "Export proposal could not be approved.",
      );
      return false;
    } finally {
      setMCPPending(false);
    }
  };
  const revokeMCPCredential = async (credentialId: string) => {
    if (mcpPending() || mcpLoading()) return;
    setMCPPending(true);
    try {
      const response = await api.request(
        `settings/mcp/credentials/${encodeURIComponent(credentialId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Credential could not be revoked.");
      await loadMCPSettings();
      setMCPStatus("MCP credential revoked.");
    } catch (error) {
      setMCPStatus(error instanceof Error ? error.message : "Credential could not be revoked.");
    } finally {
      setMCPPending(false);
    }
  };
  const rescanLibrary = async () => {
    if (rescanPending()) return;
    setRescanPending(true);
    setServerSettingsStatus("Rescanning media library…");
    try {
      const response = await api.request("settings/media/refresh", { method: "POST" });
      if (!response.ok)
        throw new Error("Media library could not be rescanned. Check mounts and permissions.");
      setServerSettingsStatus("Media library rescan started.");
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Media library rescan failed.",
      );
    } finally {
      setRescanPending(false);
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
    setSettingsPending,
    serverSettingsLoading,
    rescanPending,
    setRescanPending,
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
