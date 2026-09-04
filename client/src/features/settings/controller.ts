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
  const openSettings = async () => {
    setSettingsOpen(true);
    await loadServerSettings();
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
    } catch (error) {
      setServerSettingsStatus(
        error instanceof Error ? error.message : "Settings could not be saved.",
      );
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
    saveSettings,
    loadServerSettings,
    openSettings,
    saveRuntimeSettings,
    updateDestination,
    saveDestinations,
    rescanLibrary,
  };
}
