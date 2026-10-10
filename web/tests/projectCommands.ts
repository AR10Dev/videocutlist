import { AtomRegistry } from "effect/reactivity";
import { runEffect } from "./runEffect";
import type { ProjectsControllerDeps } from "../src/features/projects/controller";
import { createProjectsController } from "../src/features/projects/controller";

// Test-only awaiting facade: production dispatch is void and outcomes are native atoms.
export function projectCommands(
  registry: AtomRegistry.AtomRegistry,
  controller: ReturnType<typeof createProjectsController>,
) {
  const save = () =>
    runEffect(
      AtomRegistry.getResult(registry, controller.explicitSaveCommand, { suspendOnWaiting: true }),
    ).catch(() => undefined);
  const load = () =>
    runEffect(
      AtomRegistry.getResult(registry, controller.loadCommand, { suspendOnWaiting: true }),
    ).then(
      () => undefined,
      () => undefined,
    );
  return {
    saveProject: () => {
      controller.saveProject();
      return save();
    },
    retrySave: () => {
      controller.retrySave();
      return save();
    },
    saveAsNewProject: () => {
      controller.saveAsNewProject();
      return runEffect(
        AtomRegistry.getResult(registry, controller.saveAsNewAndSave, { suspendOnWaiting: true }),
      ).catch(() => undefined);
    },
    loadProject: (...args: Parameters<typeof controller.loadProject>) => {
      controller.loadProject(...args);
      return load();
    },
    reloadRemoteProject: () => {
      controller.reloadRemoteProject();
      return load();
    },
    recoverProject: () => {
      controller.recoverProject();
      return load();
    },
  };
}

export function createProjectsTestController(deps: ProjectsControllerDeps) {
  const controller = createProjectsController(deps);
  return { ...controller, ...projectCommands(deps.server.registry, controller) };
}
