import { For, Show } from "solid-js";
import type { components } from "../../generated/api";
import { createApiClient, resolveBrowserConfiguration, validInterchangeFileSize } from "../../api";
import { validateSegments, type Segment } from "../preview/model";
import { serializeProjectItem } from "./model";
import { parseProjectJson, projectJson } from "./lifecycle";
import { useWorkspace } from "../app/WorkspaceContext";
import { ProjectBrowser } from "./ProjectBrowser";

const api = createApiClient(resolveBrowserConfiguration());

export function ProjectsView() {
  const {
    selected,
    status,
    setStatus,
    projectId,
    projectName,
    setProjectName,
    revision,
    setRevision,
    dirty,
    setDirty,
    projectItems,
    activeItemId,
    recent,
    editableItems,
    activateItem,
    markDirty,
    updateTimeline,
    reorderProjectItem,
    removeProjectItem,
    projects,
  } = useWorkspace();
  return (
    <Show
      when={selected() && activeItemId()}
      fallback={
        <section class="project-panel" aria-labelledby="project-heading">
          <h2 id="project-heading">Project</h2>
          <Show
            when={selected()}
            fallback={<p>Choose a video from the Media library to start a project.</p>}
          >
            {(item) => (
              <p role="status">
                Previewing {item().name}; add it to the project before creating or saving cuts.
              </p>
            )}
          </Show>
          <ProjectBrowser />
          <Show when={status().startsWith("Project") || status().startsWith("Media request")}>
            <p role="status">{status()}</p>
          </Show>
        </section>
      }
    >
      <section class="project-panel" aria-labelledby="project-heading">
        <h2 id="project-heading">Project</h2>
        <details>
          <summary>Project details</summary>
          <p>Project ID: {projectId()}</p>
          <p>
            Revision {revision()} · {dirty() ? "unsaved changes" : "saved"}
          </p>
        </details>
        <label>
          Project name{" "}
          <input
            class="input input-bordered input-sm mt-1 w-full"
            value={projectName()}
            onInput={(event) => {
              setProjectName(event.currentTarget.value);
              markDirty();
            }}
          />
        </label>
        <ol class="project-items" aria-label="Project media items">
          <For each={projectItems()}>
            {(item, index) => (
              <li>
                <button
                  class="btn btn-ghost btn-sm justify-start"
                  aria-pressed={activeItemId() === item.id}
                  onClick={() => activateItem(item)}
                >
                  {item.media.name}
                </button>{" "}
                <Show when={projectItems().length > 1}>
                  <button
                    class="btn btn-ghost btn-xs"
                    aria-label={`Move ${item.media.name} up`}
                    disabled={index() === 0}
                    onClick={() => reorderProjectItem(item.id, -1)}
                  >
                    Move up
                  </button>{" "}
                  <button
                    class="btn btn-ghost btn-xs"
                    aria-label={`Move ${item.media.name} down`}
                    disabled={index() === projectItems().length - 1}
                    onClick={() => reorderProjectItem(item.id, 1)}
                  >
                    Move down
                  </button>{" "}
                </Show>
                <button class="btn btn-error btn-xs" onClick={() => removeProjectItem(item.id)}>
                  Remove
                </button>
              </li>
            )}
          </For>
        </ol>
        <div class="controls flex flex-wrap gap-2">
          <button
            class="btn btn-primary btn-sm"
            classList={{ primary: dirty() }}
            onClick={() => void projects.saveProject()}
          >
            Save project
          </button>
          <button class="btn btn-ghost btn-sm" onClick={projects.newProject}>
            New project
          </button>
          <button
            class="btn btn-ghost btn-sm"
            onClick={() => {
              const id = window.prompt("Project ID to load", "");
              if (id) void projects.loadProject(id);
            }}
          >
            Load project
          </button>
        </div>
        <Show when={status() || (dirty() ? "Save the project to keep your changes." : "")}>
          {(message) => <p role="status">{message()}</p>}
        </Show>
        <details>
          <summary>Interchange</summary>
          <button
            class="btn btn-ghost btn-sm"
            disabled={!selected()}
            onClick={() => {
              const blob = new Blob(
                [
                  projectJson({
                    schemaVersion: 2,
                    name: projectName(),
                    revision: revision(),
                    items: editableItems().map(serializeProjectItem),
                  }),
                ],
                { type: "application/json" },
              );
              const link = document.createElement("a");
              link.href = URL.createObjectURL(blob);
              link.download = `${projectId()}.videocutlist.json`;
              link.click();
              URL.revokeObjectURL(link.href);
            }}
          >
            Download cut list
          </button>
          <Show when={selected()} fallback={<p>Choose a video from Media to import a cut list.</p>}>
            <label>
              Import cut list{" "}
              <input
                class="file-input file-input-sm file-input-bordered mt-1 w-full"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  if (!validInterchangeFileSize(file.size)) {
                    setStatus("Cut list exceeds the 1 MiB limit.");
                    return;
                  }
                  void file
                    .text()
                    .then((text) => {
                      const imported = parseProjectJson(text);
                      if (imported.schemaVersion === 2) {
                        return projects.importProject(
                          imported as components["schemas"]["ProjectInput"],
                        );
                      }
                      if (!selected() || imported.mediaId !== selected()!.id)
                        throw new Error("Select the cut list's media before importing.");
                      const segments = imported.segments as Segment[];
                      const error = validateSegments(segments, selected()!.durationMs);
                      if (error) throw new Error(error);
                      updateTimeline({ segments });
                      markDirty();
                      setStatus("Cut list imported. Save the project to keep it.");
                    })
                    .catch((error) =>
                      setStatus(error instanceof Error ? error.message : "Cut list import failed."),
                    );
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </Show>
          <Show
            when={selected() && !dirty()}
            fallback={
              <p>
                Save or load the selected video&apos;s project before importing CSV or chapters.
              </p>
            }
          >
            <label>
              Import CSV or chapters{" "}
              <input
                class="file-input file-input-sm file-input-bordered mt-1 w-full"
                type="file"
                accept=".csv,.txt,text/csv,text/plain"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file || !validInterchangeFileSize(file.size)) {
                    setStatus("Interchange file exceeds the 1 MiB limit.");
                    return;
                  }
                  const format = file.name.toLowerCase().endsWith(".csv") ? "csv" : "chapters";
                  void file
                    .arrayBuffer()
                    .then((body) =>
                      api.interchangeRequest(
                        projectId(),
                        format,
                        {
                          method: "POST",
                          body,
                          headers: {
                            "Content-Type": format === "csv" ? "text/csv" : "text/plain",
                          },
                        },
                        activeItemId(),
                      ),
                    )
                    .then(async (response) => {
                      if (!response.ok) throw new Error();
                      const value = (await response.json()) as {
                        segments: Segment[];
                        revision: number;
                      };
                      updateTimeline({ segments: value.segments });
                      setRevision(value.revision);
                      setDirty(false);
                      setStatus("Interchange imported.");
                    })
                    .catch(() => setStatus("Interchange import failed."));
                  event.currentTarget.value = "";
                }}
              />
            </label>
          </Show>
          <Show when={dirty()}>
            <p>Save the project before importing or exporting CSV or chapters.</p>
          </Show>
          <button
            class="btn btn-ghost btn-sm"
            disabled={!selected() || dirty()}
            onClick={() =>
              void api
                .interchangeRequest(projectId(), "csv", {}, activeItemId())
                .then((response) => (response.ok ? response.blob() : Promise.reject()))
                .then((blob) => {
                  const link = document.createElement("a");
                  link.href = URL.createObjectURL(blob);
                  link.download = `${projectId()}.csv`;
                  link.click();
                  URL.revokeObjectURL(link.href);
                })
                .catch(() => setStatus("CSV export failed."))
            }
          >
            Export CSV
          </button>
          <button
            class="btn btn-ghost btn-sm"
            disabled={!selected() || dirty()}
            onClick={() =>
              void api
                .interchangeRequest(projectId(), "chapters", {}, activeItemId())
                .then((response) => (response.ok ? response.blob() : Promise.reject()))
                .then((blob) => {
                  const link = document.createElement("a");
                  link.href = URL.createObjectURL(blob);
                  link.download = `${projectId()}.chapters.txt`;
                  link.click();
                  URL.revokeObjectURL(link.href);
                })
                .catch(() => setStatus("Chapters export failed."))
            }
          >
            Export chapters
          </button>
        </details>
        <ProjectBrowser />
        <Show when={recent().length > 0}>
          <h3>Recent projects</h3>
          <ul>
            {recent().map((item) => (
              <li>
                <button
                  class="btn btn-ghost btn-sm"
                  onClick={() => void projects.loadProject(item.id)}
                >
                  {item.label}
                </button>
              </li>
            ))}
          </ul>
        </Show>
      </section>
    </Show>
  );
}
