import type { Accessor } from "solid-js";
import type { ServerState } from "../../app/server";
import * as Atom from "effect/reactivity/Atom";
import { parseTimecode, validateSegmentLabel, type Segment } from "../preview/model";

export type EditorInteraction = {
  selectedId: string | undefined;
  status: string;
  discardedMarks: boolean;
  boundaryDrafts: Record<string, Partial<Record<"start" | "end", string>>>;
  boundaryErrors: Record<string, string>;
  labelDrafts: Record<string, string>;
  labelErrors: Record<string, string>;
};

export function createInputDrafts(deps: {
  registry: ServerState["registry"];
  interactionAtom: Atom.Writable<EditorInteraction>;
  interaction: Accessor<EditorInteraction>;
  present: Accessor<{ segments: Segment[] }>;
  updateSegmentBoundary: (index: number, boundary: "start" | "end", value: number) => boolean;
  updateSegmentLabel: (index: number, label: string) => boolean;
  editorStatus: Accessor<string>;
  setEditorStatus: (message: string) => void;
}) {
  const {
    registry,
    interactionAtom,
    interaction,
    present,
    updateSegmentBoundary,
    updateSegmentLabel,
    editorStatus,
    setEditorStatus,
  } = deps;
  const setBoundaryDraft = (id: string, boundary: "start" | "end", draft: string) => {
    registry.update(interactionAtom, (value) => ({
      ...value,
      boundaryDrafts: {
        ...value.boundaryDrafts,
        [id]: { ...value.boundaryDrafts[id], [boundary]: draft },
      },
    }));
  };
  const cancelBoundary = (id: string, boundary: "start" | "end") => {
    registry.update(interactionAtom, (value) => {
      const boundaryErrors = { ...value.boundaryErrors };
      delete boundaryErrors[id];
      return {
        ...value,
        boundaryErrors,
        boundaryDrafts: {
          ...value.boundaryDrafts,
          [id]: { ...value.boundaryDrafts[id], [boundary]: undefined },
        },
      };
    });
  };
  const confirmBoundary = (id: string, boundary: "start" | "end") => {
    const draft = interaction().boundaryDrafts[id]?.[boundary];
    if (draft === undefined) return;
    const index = present().segments.findIndex((segment) => segment.id === id);
    if (index < 0) return;
    const value = parseTimecode(draft);
    if (value !== undefined && updateSegmentBoundary(index, boundary, value)) {
      cancelBoundary(id, boundary);
      return;
    }
    const message =
      value === undefined ? "Enter a valid timecode within this video." : editorStatus();
    registry.update(interactionAtom, (value) => ({
      ...value,
      boundaryErrors: { ...value.boundaryErrors, [id]: message },
    }));
  };
  const editLabelDraft = (id: string, label: string) => {
    const index = present().segments.findIndex((segment) => segment.id === id);
    if (index < 0) return;
    const error = validateSegmentLabel(label);
    registry.update(interactionAtom, (value) => {
      const labelErrors = { ...value.labelErrors };
      if (error) labelErrors[id] = error;
      else delete labelErrors[id];
      return { ...value, labelErrors, labelDrafts: { ...value.labelDrafts, [id]: label } };
    });
    if (error) setEditorStatus(error);
    else updateSegmentLabel(index, label);
  };
  const commitLabelDraft = (id: string) => {
    if (validateSegmentLabel(interaction().labelDrafts[id] ?? "")) return;
    registry.update(interactionAtom, (value) => {
      const labelDrafts = { ...value.labelDrafts };
      delete labelDrafts[id];
      return { ...value, labelDrafts };
    });
  };

  return { setBoundaryDraft, cancelBoundary, confirmBoundary, editLabelDraft, commitLabelDraft };
}
