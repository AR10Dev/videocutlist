import { For, Show } from "solid-js";
import { canStreamPreview } from "../preview/model";
import {
  appearances,
  defaultSettings,
  settingsKey,
  type AppSettings,
  type Appearance,
} from "./model";
import { useWorkspace } from "../app/WorkspaceContext";

export function SettingsView() {
  const {
    setSettings,
    appearance,
    setAppearance,
    serverSettingsStatus,
    libraryRoots,
    settingsRevision,
    runtimeSettings,
    settingsPending,
    rescanPending,
    muted,
    setMuted,
    diagnostics,
    cutStrategy,
    setCutStrategy,
    filenameTemplate,
    setFilenameTemplate,
    saveSettings,
    saveRuntimeSettings,
    updateDestination,
    saveDestinations,
    rescanLibrary,
  } = useWorkspace();
  return (
    <section class="settings-view flex flex-col gap-4 p-4" aria-labelledby="settings-heading">
      <div class="panel-heading">
        <h2 id="settings-heading">Settings</h2>
      </div>
      <p>Browser-local preferences stay in this browser and do not change server configuration.</p>
      <section aria-labelledby="browser-settings-heading">
        <h3 id="browser-settings-heading">Preferences</h3>
        <label>
          Theme
          <select
            class="select select-bordered select-sm mt-1 w-full"
            value={appearance()}
            onChange={(event) => {
              const value = event.currentTarget.value as Appearance;
              setAppearance(value);
              saveSettings({ appearance: value });
            }}
          >
            <For each={appearances}>
              {(theme) => (
                <option value={theme}>
                  {theme === "cmyk" ? "CMYK" : theme[0].toUpperCase() + theme.slice(1)}
                </option>
              )}
            </For>
          </select>
        </label>
        <label>
          <input
            class="input input-bordered input-sm mt-1 w-full"
            type="checkbox"
            checked={muted()}
            onChange={(event) => {
              const value = event.currentTarget.checked;
              setMuted(value);
              saveSettings({ muted: value });
            }}
          />{" "}
          Mute previews
        </label>
        <button
          class="btn btn-ghost btn-sm"
          type="button"
          onClick={() => {
            setSettings(defaultSettings);
            setCutStrategy(defaultSettings.cutStrategy);
            setFilenameTemplate(defaultSettings.filenameTemplate);
            setMuted(defaultSettings.muted);
            setAppearance(defaultSettings.appearance);
            localStorage.setItem(settingsKey, JSON.stringify(defaultSettings));
          }}
        >
          Reset browser preferences
        </button>
      </section>
      <section aria-labelledby="library-settings-heading">
        <h3 id="library-settings-heading">Media library</h3>
        <p>
          Media roots are deployment-managed. This browser only shows safe aliases and availability.
        </p>
        <Show when={libraryRoots().length > 0} fallback={<p>No media roots configured.</p>}>
          <div class="library-roots" aria-label="Media roots">
            <For each={libraryRoots()}>
              {(root) => (
                <div class="library-root">
                  <span>
                    Alias: <strong>{root.alias}</strong>
                  </span>
                  <span role="status">
                    {root.state === "unavailable" ? root.message : (root.message ?? "Available")}
                  </span>
                </div>
              )}
            </For>
          </div>
        </Show>
        <div class="settings-actions">
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            onClick={() => void rescanLibrary()}
            disabled={rescanPending() || settingsPending()}
          >
            {rescanPending() ? "Rescanning…" : "Rescan library"}
          </button>
        </div>
      </section>
      <section aria-labelledby="exports-settings-heading">
        <h3 id="exports-settings-heading">Export defaults</h3>
        <label>
          Cut strategy
          <select
            class="select select-bordered select-sm mt-1 w-full"
            value={cutStrategy()}
            onChange={(event) => {
              const value = event.currentTarget.value as AppSettings["cutStrategy"];
              setCutStrategy(value);
              saveSettings({ cutStrategy: value });
            }}
          >
            <option value="stream_copy_preferred">Stream copy preferred</option>
            <option value="precise_reencode">Precise re-encode</option>
            <option value="hybrid_smart_cut">Hybrid smart cut</option>
          </select>
        </label>
        <label>
          Filename template
          <input
            class="input input-bordered input-sm mt-1 w-full"
            value={filenameTemplate()}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setFilenameTemplate(value);
              saveSettings({ filenameTemplate: value });
            }}
          />
        </label>
      </section>
      <section aria-labelledby="destinations-settings-heading">
        <h3 id="destinations-settings-heading">Destinations</h3>
        <p>Original media is never modified.</p>
        <Show when={runtimeSettings()?.destinations?.length}>
          <ul>
            <For each={runtimeSettings()?.destinations}>
              {(destination) => (
                <li>
                  <label>
                    Name
                    <input
                      class="input input-bordered input-sm mt-1 w-full"
                      value={destination.label}
                      onChange={(event) =>
                        updateDestination(destination.id, { label: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label>
                    Description
                    <input
                      class="input input-bordered input-sm mt-1 w-full"
                      value={destination.description ?? ""}
                      onChange={(event) =>
                        updateDestination(destination.id, {
                          description: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <label>
                    Retention
                    <input
                      class="input input-bordered input-sm mt-1 w-full"
                      value={destination.retention ?? ""}
                      placeholder="for example 30d"
                      onChange={(event) =>
                        updateDestination(destination.id, {
                          retention: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <span>
                    {destination.kind === "download" ? "Browser download" : "Saved export"} ·{" "}
                    {destination.retention ?? "durable"}
                  </span>
                </li>
              )}
            </For>
          </ul>
          <button
            class="btn btn-ghost btn-sm"
            type="button"
            onClick={saveDestinations}
            disabled={settingsPending()}
          >
            {settingsPending() ? "Saving…" : "Save destination settings"}
          </button>
        </Show>
      </section>
      <section class="server-settings" aria-labelledby="processing-settings-heading">
        <details>
          <summary id="processing-settings-heading">Server processing</summary>
          <p>Changes apply to future jobs; running jobs keep their current settings.</p>
          <h4>Export</h4>
          <label>
            Export concurrency{" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="1"
              value={runtimeSettings()?.exportLimit ?? ""}
              onChange={(event) =>
                void saveRuntimeSettings(
                  { exportLimit: event.currentTarget.valueAsNumber },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <h4>Preview</h4>
          <label>
            Preview global concurrency{" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="1"
              value={runtimeSettings()?.previewGlobalLimit ?? ""}
              onChange={(event) =>
                void saveRuntimeSettings(
                  { previewGlobalLimit: event.currentTarget.valueAsNumber },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <label>
            Preview before (seconds){" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="0.001"
              step="0.1"
              value={
                runtimeSettings()?.previewBeforeMs ? runtimeSettings()!.previewBeforeMs! / 1000 : ""
              }
              onChange={(event) =>
                void saveRuntimeSettings(
                  { previewBeforeMs: event.currentTarget.valueAsNumber * 1000 },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <label>
            Preview after (seconds){" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="0.001"
              step="0.1"
              value={
                runtimeSettings()?.previewAfterMs ? runtimeSettings()!.previewAfterMs! / 1000 : ""
              }
              onChange={(event) =>
                void saveRuntimeSettings(
                  { previewAfterMs: event.currentTarget.valueAsNumber * 1000 },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <label>
            Preview maximum window (seconds){" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="0.001"
              step="0.1"
              value={runtimeSettings()?.previewMaxMs ? runtimeSettings()!.previewMaxMs! / 1000 : ""}
              onChange={(event) =>
                void saveRuntimeSettings(
                  { previewMaxMs: event.currentTarget.valueAsNumber * 1000 },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <label>
            Preview grid (seconds){" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="0.001"
              step="0.1"
              value={
                runtimeSettings()?.previewGridMs ? runtimeSettings()!.previewGridMs! / 1000 : ""
              }
              onChange={(event) =>
                void saveRuntimeSettings(
                  { previewGridMs: event.currentTarget.valueAsNumber * 1000 },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <h4>Library scan</h4>
          <label>
            Media scan file limit{" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="1"
              value={runtimeSettings()?.mediaMaxFiles ?? ""}
              onChange={(event) =>
                void saveRuntimeSettings(
                  { mediaMaxFiles: event.currentTarget.valueAsNumber },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <label>
            Media scan depth limit{" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="1"
              value={runtimeSettings()?.mediaMaxDepth ?? ""}
              onChange={(event) =>
                void saveRuntimeSettings(
                  { mediaMaxDepth: event.currentTarget.valueAsNumber },
                  "Processing settings saved.",
                )
              }
            />
          </label>
          <h4>Cache</h4>
          <label>
            Disposable cache size (MB){" "}
            <input
              class="input input-bordered input-sm mt-1 w-full"
              type="number"
              min="1"
              value={
                runtimeSettings()?.cacheMaxBytes
                  ? runtimeSettings()!.cacheMaxBytes! / 1_000_000
                  : ""
              }
              onChange={(event) =>
                void saveRuntimeSettings(
                  { cacheMaxBytes: event.currentTarget.valueAsNumber * 1_000_000 },
                  "Processing settings saved.",
                )
              }
            />
          </label>
        </details>
      </section>
      <details class="settings-diagnostics">
        <summary>Diagnostics</summary>
        <dl>
          <dt>MSE</dt>
          <dd>{canStreamPreview() ? "supported" : "unsupported"}</dd>
          <dt>Cache</dt>
          <dd>{diagnostics()?.cache ?? "—"}</dd>
          <dt>Request ID</dt>
          <dd>{diagnostics()?.requestId ?? "—"}</dd>
          <dt>Offset</dt>
          <dd>{diagnostics() ? `${diagnostics()!.offsetMs} ms` : "—"}</dd>
          <dt>Window</dt>
          <dd>
            {diagnostics() ? `${diagnostics()!.startMs} ms / ${diagnostics()!.durationMs} ms` : "—"}
          </dd>
          <dt>Response</dt>
          <dd>{diagnostics() ? `${diagnostics()!.elapsedMs} ms` : "—"}</dd>
        </dl>
        <p>Settings revision {settingsRevision()}</p>
      </details>
      <Show when={serverSettingsStatus() !== "Administrator settings loaded."}>
        <p role="status">{serverSettingsStatus()}</p>
      </Show>
    </section>
  );
}
