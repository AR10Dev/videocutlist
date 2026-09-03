import { createContext, useContext, type JSX } from "solid-js";
import type { WorkspaceController } from "./controller";

const WorkspaceContext = createContext<WorkspaceController>();

export function WorkspaceProvider(props: { value: WorkspaceController; children: JSX.Element }) {
  return (
    <WorkspaceContext.Provider value={props.value}>{props.children}</WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceController {
  const controller = useContext(WorkspaceContext);
  if (!controller) throw new Error("WorkspaceProvider is missing.");
  return controller;
}
