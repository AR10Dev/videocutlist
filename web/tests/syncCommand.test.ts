import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { describe, expect, it } from "@effect/vitest";
import { syncCommand } from "../src/app/syncCommand";

describe("syncCommand", () => {
  it("returns typed synchronous values and updates runtime-owned atoms", () => {
    const registry = AtomRegistry.make();
    try {
      const calls: number[] = [];
      const command = syncCommand<number, string>(
        registry,
        (value) => {
          calls.push(value);
          return `value:${value}`;
        },
        () => new Error("safe failure"),
      );
      expect(command(7)).toBe("value:7");
      expect(command(9)).toBe("value:9");
      expect(calls).toEqual([7, 9]);
      expect(registry.getNodes().size).toBeGreaterThan(0);
    } finally {
      registry.dispose();
    }
    expect(registry.getNodes().size).toBe(0);
  });

  it("replaces internal failures without returning stale results and recovers", () => {
    const registry = AtomRegistry.make();
    try {
      const command = syncCommand<number, string>(
        registry,
        (input) => {
          if (input === 2) throw new Error("private detail");
          return `result:${input}`;
        },
        () => new Error("Unable to complete command."),
      );
      expect(command(1)).toBe("result:1");
      expect(() => command(2)).toThrow("Unable to complete command.");
      expect(command(3)).toBe("result:3");
    } finally {
      registry.dispose();
    }
  });

  it("preserves reentrant synchronous invocation results", () => {
    const registry = AtomRegistry.make();
    try {
      type Input = { label: string; nest?: boolean };
      const calls: string[] = [];
      const command = syncCommand<Input, string>(
        registry,
        (input) => {
          calls.push(`start:${input.label}`);
          if (input.nest) calls.push(`nested:${command({ label: "inner" })}`);
          return `result:${input.label}`;
        },
        () => new Error("Unable to dispatch command."),
      );
      expect(command({ label: "outer", nest: true })).toBe("result:outer");
      expect(calls).toEqual(["start:outer", "start:inner", "nested:result:inner"]);
      expect(command({ label: "later" })).toBe("result:later");
    } finally {
      registry.dispose();
    }
  });
});
