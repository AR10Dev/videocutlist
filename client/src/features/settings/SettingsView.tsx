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
    setSettingsOpen,
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
    <section class="settings-view" aria-labelledby="settings-heading">
      <div class="panel-heading">
        <h2 id="settings-heading">Settings</h2>
        <button type="button" onClick={() => setSettingsOpen(false)}>
          Back to editor
        </button>
      </div>
      <p>Browser-local preferences stay in this browser and do not change server configuration.</p>
      <section aria-labelledby="appearance-settings-heading">
        <h3 id="appearance-settings-heading">Appearance</h3>
        <label>
          Theme
          <select
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
      </section>
      <section aria-labelledby="library-settings-heading">
        <h3 id="library-settings-heading">Library</h3>
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
            type="button"
            onClick={() => void rescanLibrary()}
            disabled={rescanPending() || settingsPending()}
          >
            {rescanPending() ? "Rescanning…" : "Rescan library"}
          </button>
        </div>
        <p class="settings-revision">Settings revision {settingsRevision()}</p>
      </section>
      <section aria-labelledby="exports-settings-heading">
        <h3 id="exports-settings-heading">Exports</h3>
        <p>
          Source media is read-only. Exports are retained according to each destination policy;
          cache data is disposable.
        </p>
        <label>
          Cut strategy (saved in this browser)
          <select
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
          Filename template (saved in this browser)
          <input
            value={filenameTemplate()}
            onInput={(event) => {
              const value = event.currentTarget.value;
              setFilenameTemplate(value);
              saveSettings({ filenameTemplate: value });
            }}
          />
        </label>
        <Show when={runtimeSettings()?.destinations?.length}>
          <h4>Destinations</h4>
          <ul>
            <For each={runtimeSettings()?.destinations}>
              {(destination) => (
                <li>
                  <label>
                    Name
                    <input
                      value={destination.label}
                      onChange={(event) =>
                        updateDestination(destination.id, { label: event.currentTarget.value })
                      }
                    />
                  </label>
                  <label>
                    Description
                    <input
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
                      value={destination.retention ?? ""}
                      placeholder="for example 30d"
                      onChange={(event) =>
                        updateDestination(destination.id, {
                          retention: event.currentTarget.value,
                        })
                      }
                    />
                  </label>
                  <span>{destination.kind} · deployment-managed location</span>
                </li>
              )}
            </For>
          </ul>
          <button type="button" onClick={saveDestinations} disabled={settingsPending()}>
            {settingsPending() ? "Saving…" : "Save destination settings"}
          </button>
          <p>
            Destination roots are deployment-controlled and remain within configured export bases.
          </p>
        </Show>
      </section>
      <section aria-labelledby="performance-settings-heading">
        <h3 id="performance-settings-heading">Performance</h3>
        <p>Changes apply to the next job; running FFmpeg jobs are not reconfigured.</p>
        <label>
          Export concurrency{" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.exportLimit ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { exportLimit: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Preview global concurrency{" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.previewGlobalLimit ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { previewGlobalLimit: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Preview before (ms){" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.previewBeforeMs ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { previewBeforeMs: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Preview after (ms){" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.previewAfterMs ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { previewAfterMs: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Preview maximum window (ms){" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.previewMaxMs ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { previewMaxMs: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Preview grid (ms){" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.previewGridMs ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { previewGridMs: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Media scan file limit{" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.mediaMaxFiles ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { mediaMaxFiles: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Media scan depth limit{" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.mediaMaxDepth ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { mediaMaxDepth: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
        <label>
          Disposable cache size (bytes){" "}
          <input
            type="number"
            min="1"
            value={runtimeSettings()?.cacheMaxBytes ?? ""}
            onChange={(event) =>
              void saveRuntimeSettings(
                { cacheMaxBytes: event.currentTarget.valueAsNumber },
                "Performance settings saved.",
              )
            }
          />
        </label>
      </section>
      <section aria-labelledby="editor-settings-heading">
        <h3 id="editor-settings-heading">Editor</h3>
        <label>
          <input
            type="checkbox"
            checked={muted()}
            onChange={(event) => {
              const value = event.currentTarget.checked;
              setMuted(value);
              saveSettings({ muted: value });
            }}
          />{" "}
          Mute preview by default (saved in this browser)
        </label>
        <button
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
      <section aria-labelledby="about-settings-heading">
        <h3 id="about-settings-heading">About / Diagnostics</h3>
        <p>Preview request and cache diagnostics are kept out of the clipping workspace.</p>
        <details>
          <summary>Preview diagnostics</summary>
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
              {diagnostics()
                ? `${diagnostics()!.startMs} ms / ${diagnostics()!.durationMs} ms`
                : "—"}
            </dd>
            <dt>Response</dt>
            <dd>{diagnostics() ? `${diagnostics()!.elapsedMs} ms` : "—"}</dd>
          </dl>
        </details>
        <p role="status">{serverSettingsStatus()}</p>
      </section>
    </section>
  );
}
