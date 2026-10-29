import type { WorkspaceController } from "../../app/controller";
import type { ExportContainer } from "../projects/model";
import { summarizeExports } from "./summary";
import { containerLabel } from "./labels";
import { isJobActive } from "./queueResponse";

export function createExportPlan(workspace: WorkspaceController) {
  const { selected, editableItems } = workspace;
  const exportFeature = workspace.export;
  const {
    exportItemIDs,
    exportSelection,
    exportContainer,
    streamIndexes,
    exportJob,
    batchJobs,
    preflight,
    destinationsLoading,
    destinationsError,
    preflightPending,
  } = exportFeature;
  const tracks = workspace.editor.tracks;
  const summary = () =>
    summarizeExports(editableItems().filter((item) => exportItemIDs().includes(item.id)));
  const emptyItem = () =>
    exportSelection() === "segments" ? summary().find((item) => item.outputs === 0) : undefined;
  const expectedOutputs = () => summary().reduce((total, item) => total + item.outputs, 0);
  const plannedContainerLabel = () => {
    const selectedIds = new Set(exportItemIDs());
    const containers = new Set<ExportContainer>();
    for (const item of editableItems())
      if (selectedIds.has(item.id)) containers.add(item.exportOptions.container ?? "mkv");
    return containers.size
      ? [...containers].map(containerLabel).join(" + ")
      : containerLabel(exportContainer());
  };
  const availableDestinations = exportFeature.availableDestinations;
  const itemDestinationId = (id: string) =>
    editableItems().find((item) => item.id === id)?.exportOptions.destinationId ?? "download";
  const exportDestinationLabel = () => {
    const labels = [
      ...new Set(
        exportItemIDs().map(
          (id) =>
            availableDestinations().find((destination) => destination.id === itemDestinationId(id))
              ?.label ?? itemDestinationId(id),
        ),
      ),
    ];
    return labels.length === 1 ? labels[0] : `${labels.length} destinations`;
  };
  const unavailableDestinationItem = () =>
    editableItems().find(
      (item) =>
        exportItemIDs().includes(item.id) &&
        !availableDestinations().some(
          (destination) => destination.id === itemDestinationId(item.id),
        ),
    );
  const automaticTracks = () => streamIndexes().length === 0;
  const hiddenStreamIndexes = () =>
    streamIndexes().filter((index) => !tracks().some((track) => track.index === index));
  const preflightFindings = () =>
    (preflight()?.findings ?? []).filter((finding) => finding.severity !== "allowed");
  const blockedFinding = () =>
    preflightFindings().find((finding) => finding.severity === "blocked");
  const exportActive = () =>
    !exportFeature.exportCancellationPending() &&
    (isJobActive(exportJob()) || batchJobs().some(isJobActive));
  const planBlocker = () => {
    if (!selected()) return "Choose a video before exporting.";
    if (!exportItemIDs().length) return "Select at least one project item.";
    if (emptyItem()) return "Add or include a segment before creating clips.";
    if (destinationsLoading()) return "Loading configured destinations…";
    if (destinationsError()) return "Destinations could not be loaded.";
    if (!availableDestinations().length) return "No export destination is configured.";
    const unavailable = unavailableDestinationItem();
    if (unavailable) return `Choose an available destination for ${unavailable.media.name}.`;
    if (preflightPending()) return "Checking export requirements…";
    const blocked = blockedFinding();
    if (blocked) return blocked.message;
    if (preflight()?.allowed === false)
      return "The server blocked this export. Review the export settings.";
    return "";
  };
  const planReady = () => !planBlocker();

  return {
    summary,
    expectedOutputs,
    plannedContainerLabel,
    exportDestinationLabel,
    availableDestinations,
    itemDestinationId,
    automaticTracks,
    hiddenStreamIndexes,
    preflightFindings,
    exportActive,
    planBlocker,
    planReady,
  };
}
