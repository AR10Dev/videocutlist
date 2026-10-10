import { describe, expect, it } from "vitest";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { createApiClient } from "../src/api";
import { createServerState } from "../src/features/app/server";
import { createWorkspaceIdentity } from "../src/features/app/workspaceIdentity";

function workspace() {
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {
        const i = tasks.indexOf(task);
        if (i >= 0) tasks.splice(i, 1);
      };
    },
  });
  const configuration = {
    serverBaseUrl: "http://localhost",
    authentication: { type: "none" as const },
  };
  const server = createServerState(createApiClient(configuration), registry, configuration);
  return {
    flush: () => {
      while (tasks.length) tasks.shift()!();
    },
    registry,
    identity: createWorkspaceIdentity(server),
  };
}

describe("workspace identity", () => {
  it("publishes a coherent context without counting identity, revision or notices as edits", () => {
    const { registry, identity, flush } = workspace();
    try {
      const contexts: string[] = [];
      const release = registry.subscribe(identity.context, (value) => contexts.push(value), {
        immediate: true,
      });
      contexts.length = 0;
      identity.updateContext({
        projectId: "p_loadedproject",
        projectName: "Loaded",
        selectedMediaId: "m_one",
        activeItemId: "i_one",
        revision: 7,
      });
      flush();
      expect(contexts).toEqual(["p_loadedproject::m_one::i_one::1"]);
      identity.setStatus("Metadata refreshed");
      identity.setRevision(8);
      expect(registry.get(identity.state).editVersion).toBe(0);
      identity.editName("My edits");
      identity.editName("My edits");
      expect(registry.get(identity.state)).toMatchObject({
        projectName: "My edits",
        dirty: true,
        editVersion: 1,
      });
      identity.updateContext({ selectedMediaId: "m_two", activeItemId: undefined });
      expect(registry.get(identity.context)).toBe("p_loadedproject::m_two::::2");
      identity.markDirty();
      expect(registry.get(identity.state).editVersion).toBe(2);
      identity.setDirty(false);
      expect(registry.get(identity.state).editVersion).toBe(2);
      release();
    } finally {
      registry.dispose();
    }
  });

  it("retains authoritative edits after unsubscription and isolates workspaces", async () => {
    const a = workspace();
    const b = workspace();
    try {
      const release = a.registry.subscribe(a.identity.state, () => undefined);
      a.identity.editName("Retained edit");
      a.identity.setStatus("Retained notice");
      release();
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      a.flush();
      expect(a.registry.get(a.identity.state)).toMatchObject({
        projectName: "Retained edit",
        status: "Retained notice",
        editVersion: 1,
      });
      expect(b.registry.get(b.identity.state)).toMatchObject({
        projectName: "Untitled project",
        editVersion: 0,
        dirty: false,
      });
      a.registry.dispose();
      b.identity.editName("Still live");
      expect(b.registry.get(b.identity.state).projectName).toBe("Still live");
    } finally {
      a.registry.dispose();
      b.registry.dispose();
    }
  });
});
