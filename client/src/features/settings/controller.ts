import { createSignal } from "solid-js";
import type { ApiClient } from "../../api";
import type { components } from "../../generated/api";
import { settingsKey, storedSettings, type AppSettings, type Appearance } from "./model";

type LibraryRoot = {
  alias: string;
  state?: "ready" | "unavailable";
  message?: string;
};
type RuntimeDestination = components["schemas"]["RuntimeDestination"];
type ServerRuntimeSettings = components["schemas"]["RuntimeSettings"];
type ServerSettings = components["schemas"]["SettingsResponse"];
type MCPSettings = components["schemas"]["MCPSettingsResponse"];
type MCPCredentialCreate = components["schemas"]["MCPCredentialCreate"];
type MCPCredentialCreated = components["schemas"]["MCPCredentialCreated"];
type ExportProposal = components["schemas"]["ExportProposal"];

export function createSettingsController(api: ApiClient) {
  const [settings, setSettings] = createSignal(storedSettings(localStorage));
  const [appearance, setAppearance] = createSignal<Appearance>(settings().appearance);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  const [serverSettingsStatus, setServerSettingsStatus] = createSignal("");
  const [libraryRoots, setLibraryRoots] = createSignal<LibraryRoot[]>([]);
  const [settingsRevision, setSettingsRevision] = createSignal(0);
  const [runtimeSettings, setRuntimeSettings] = createSignal<ServerRuntimeSettings>();
  const [settingsPending, setSettingsPending] = createSignal(false);
  const [rescanPending, setRescanPending] = createSignal(false);
  const [mcpSettings, setMCPSettings] = createSignal<MCPSettings>();
  const [mcpPending, setMCPPending] = createSignal(false);
  const [revealedMCPSecret, setRevealedMCPSecret] = createSignal("");

  const saveSettings = (changes: Partial<AppSettings>) => {
    const next = { ...settings(), ...changes };
    setSettings(next);
    setAppearance(next.appearance);
    localStorage.setItem(settingsKey, JSON.stringify(next));
  };
  const loadServerSettings = async () => {
    setServerSettingsStatus("Loading administrator settings…");
    try {
      const response = await api.request("settings");
      if (response.status === 403)
        throw new Error("Administrator settings are unavailable: your account is not authorized.");
      if (!response.ok) throw new Error("Administrator settings are unavailable on this server.");
      const value = (await response.json()) as ServerSettings;
      setLibraryRoots(
        Object.entries(value.roots ?? {}).map(([alias, root]) => ({ alias, ...root })),
      );
      setSettingsRevision(value.revision);
      setRuntimeSettings(value.settings);
      setServerSettingsStatus("Administrator settings loaded.");
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error
          ? error.message
          : "Administrator settings are unavailable on this server.",
      );
    }
  };
  const loadMCPSettings = async () => {
    try {
      const response = await api.request("settings/mcp");
      if (!response.ok) throw new Error("MCP settings are unavailable on this server.");
      const value = (await response.json()) as MCPSettings;
      setMCPSettings({
        ...value,
        endpoint: new URL(value.endpoint, api.url("settings")).toString(),
      });
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "MCP settings are unavailable on this server.",
      );
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
    if (settingsPending()) return;
    setSettingsPending(true);
    setServerSettingsStatus("Saving administrator settings…");
    try {
      const current = await api.request("settings");
      if (!current.ok) throw new Error("Settings could not be reloaded before saving.");
      const value = (await current.json()) as ServerSettings;
      const response = await api.request("settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          revision: value.revision,
          settings: { ...value.settings, ...changes },
        }),
      });
      if (!response.ok)
        throw new Error(
          response.status === 409
            ? "Settings changed; reload before updating."
            : "Settings were rejected. Check the configured limits.",
        );
      const saved = (await response.json()) as ServerSettings;
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
  const updateDestination = (id: string, changes: Partial<RuntimeDestination>) => {
    const current = runtimeSettings();
    if (!current?.destinations) return;
    setRuntimeSettings({
      ...current,
      destinations: current.destinations.map((destination) =>
        destination.id === id ? { ...destination, ...changes } : destination,
      ),
    });
  };
  const saveDestinations = () =>
    void saveRuntimeSettings(
      { destinations: runtimeSettings()?.destinations },
      "Export destination settings saved.",
    );
  const setMCPEnabled = async (enabled: boolean) => {
    if (
      await saveRuntimeSettings({ mcpEnabled: enabled }, `MCP ${enabled ? "enabled" : "disabled"}.`)
    )
      setMCPSettings((current) => (current ? { ...current, enabled } : current));
  };
  const createMCPCredential = async (input: MCPCredentialCreate) => {
    if (mcpPending()) return false;
    setMCPPending(true);
    setRevealedMCPSecret("");
    try {
      const response = await api.request("settings/mcp/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!response.ok) throw new Error("Credential settings were rejected.");
      const created = (await response.json()) as MCPCredentialCreated;
      setRevealedMCPSecret(created.secret);
      await loadMCPSettings();
      setServerSettingsStatus(
        "MCP credential created. Copy the secret now; it will not be shown again.",
      );
      return true;
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Credential could not be created.",
      );
      return false;
    } finally {
      setMCPPending(false);
    }
  };
  const approveExportProposal = async (proposalId: string) => {
    if (mcpPending()) return false;
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
      setServerSettingsStatus(`Export proposal ${approved.id} approved.`);
      return true;
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Export proposal could not be approved.",
      );
      return false;
    } finally {
      setMCPPending(false);
    }
  };
  const revokeMCPCredential = async (credentialId: string) => {
    if (mcpPending()) return;
    setMCPPending(true);
    try {
      const response = await api.request(
        `settings/mcp/credentials/${encodeURIComponent(credentialId)}`,
        { method: "DELETE" },
      );
      if (!response.ok) throw new Error("Credential could not be revoked.");
      await loadMCPSettings();
      setServerSettingsStatus("MCP credential revoked.");
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Credential could not be revoked.",
      );
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
    rescanPending,
    setRescanPending,
    mcpSettings,
    mcpPending,
    revealedMCPSecret,
    saveSettings,
    loadServerSettings,
    openSettings,
    saveRuntimeSettings,
    updateDestination,
    saveDestinations,
    setMCPEnabled,
    createMCPCredential,
    approveExportProposal,
    revokeMCPCredential,
    rescanLibrary,
  };
}
