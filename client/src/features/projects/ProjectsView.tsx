import { For, Show } from "solid-js";
import { createApiClient, resolveBrowserConfiguration, validInterchangeFileSize } from "../../api";
import { validateSegments, type Segment } from "../preview/model";
import { serializeProjectItem } from "./model";
import { parseProjectJson, projectJson } from "./lifecycle";
import { useWorkspace } from "../app/WorkspaceContext";

const api = createApiClient(resolveBrowserConfiguration());

export function ProjectsView() {
  const {
    selected,
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
    <Show when={selected()}>
      <section class="project-panel" aria-labelledby="project-heading">
        <h2 id="project-heading">Project</h2>
        <details>
          <summary>Project details</summary>
          <p>
            Revision {revision()} · {dirty() ? "unsaved changes" : "saved"}
          </p>
        </details>
        <label>
          Project name{" "}
          <input
            value={projectName()}
            onInput={(event) => {
              setProjectName(event.currentTarget.value);
              markDirty();
            }}
          />
        </label>
        <ol aria-label="Project media items">
          <For each={projectItems()}>
            {(item, index) => (
              <li>
                <button
                  aria-pressed={activeItemId() === item.id}
                  onClick={() => activateItem(item)}
                >
                  {item.media.name}
                </button>{" "}
                <button
                  aria-label={`Move ${item.media.name} up`}
                  disabled={index() === 0}
                  onClick={() => reorderProjectItem(item.id, -1)}
                >
                  Move up
                </button>{" "}
                <button
                  aria-label={`Move ${item.media.name} down`}
                  disabled={index() === projectItems().length - 1}
                  onClick={() => reorderProjectItem(item.id, 1)}
                >
                  Move down
                </button>{" "}
                <button
                  class="destructive"
                  onClick={() => {
                    if (
                      item.timeline.present.segments.length &&
                      !window.confirm(`Remove ${item.media.name} and its edits?`)
                    )
                      return;
                    removeProjectItem(item.id);
                  }}
                >
                  Remove
                </button>
              </li>
            )}
          </For>
        </ol>
        <div class="controls">
          <button class="primary" onClick={() => void projects.saveProject()}>Save project</button>
          <button onClick={projects.newProject}>New project</button>
          <button onClick={() => void projects.loadProject()}>Load project</button>
        </div>
        <Show when={dirty()}>
          <p role="status">Save this project to keep your changes.</p>
        </Show>
        <details>
          <summary>Interchange</summary>
          <p>Import or export cut lists without changing the media library.</p>
          <button
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
          <Show
            when={selected()}
            fallback={<p>Choose a video from File explorer to import a cut list.</p>}
          >
            <label>
              Import cut list{" "}
              <input
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.currentTarget.files?.[0];
                  if (!file) return;
                  void file
                    .text()
                    .then((text) => {
                      const imported = parseProjectJson(text);
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
          <p>Save or load the selected video&apos;s project before exporting CSV or chapters.</p>
          <button
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
        <Show when={recent().length > 0}>
          <h3>Recent projects</h3>
          <ul>
            {recent().map((item) => (
              <li>
                <button onClick={() => void projects.loadProject(item.id)}>{item.label}</button>
              </li>
            ))}
          </ul>
        </Show>
      </section>
    </Show>
  );
}
