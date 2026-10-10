import * as Atom from "effect/reactivity/Atom";
import { newProjectId } from "../projects/lifecycle";
import type { ServerState } from "./server";

export type WorkspaceIdentity = {
  projectId: string;
  projectName: string;
  revision: number;
  selectedMediaId: string | undefined;
  activeItemId: string | undefined;
  generation: number;
  dirty: boolean;
  editVersion: number;
  status: string;
};

export type WorkspaceContextUpdate = Partial<
  Pick<
    WorkspaceIdentity,
    "projectId" | "projectName" | "revision" | "selectedMediaId" | "activeItemId" | "dirty"
  >
>;

export function createWorkspaceIdentity(server: ServerState) {
  const { registry } = server;
  // Identity and edits survive view unsubscription until the workspace registry is disposed.
  const state = Atom.keepAlive(
    Atom.make<WorkspaceIdentity>({
      projectId: newProjectId(),
      projectName: "Untitled project",
      revision: 0,
      selectedMediaId: undefined,
      activeItemId: undefined,
      generation: 0,
      dirty: false,
      editVersion: 0,
      status: "Loading media…",
    }),
  );
  const context = Atom.make((get) => {
    const value = get(state);
    return `${value.projectId}::${value.selectedMediaId ?? ""}::${value.activeItemId ?? ""}::${value.generation}`;
  });
  return {
    state,
    context,
    updateContext: (update: WorkspaceContextUpdate) =>
      registry.update(state, (value) => ({
        ...value,
        ...update,
        generation: value.generation + 1,
      })),
    editName: (projectName: string) =>
      registry.update(state, (value) =>
        value.projectName === projectName
          ? value
          : { ...value, projectName, dirty: true, editVersion: value.editVersion + 1 },
      ),
    markDirty: () =>
      registry.update(state, (value) => ({
        ...value,
        dirty: true,
        editVersion: value.editVersion + 1,
      })),
    setDirty: (dirty: boolean) => registry.update(state, (value) => ({ ...value, dirty })),
    setRevision: (revision: number) => registry.update(state, (value) => ({ ...value, revision })),
    setStatus: (status: string) => registry.update(state, (value) => ({ ...value, status })),
  };
}
