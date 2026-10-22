import { createContext, useContext } from "solid-js";
import type { WorkspaceController } from "./controller";

const WorkspaceContext = createContext<WorkspaceController>();

export const WorkspaceProvider = WorkspaceContext.Provider;

export function useWorkspace(): WorkspaceController {
  const controller = useContext(WorkspaceContext);
  if (!controller) throw new Error("WorkspaceProvider is missing.");
  return controller;
}
