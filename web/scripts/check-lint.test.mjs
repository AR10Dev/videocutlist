import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const web = fileURLToPath(new URL("../", import.meta.url));
const oxlint = fileURLToPath(new URL("../node_modules/oxlint/bin/oxlint", import.meta.url));

test("configured lint rules reject regressions", async (t) => {
  // Keep probes inside the TS project so type-aware rules resolve the real configuration.
  const directory = mkdtempSync(`${web}src/lint-check-`);
  const file = `${directory}/probe.tsx`;
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixtures = [
    {
      name: "valid Solid component",
      source:
        'import { createSignal } from "solid-js"; export function Counter() { const [count] = createSignal(0); return <p>{count()}</p>; }',
    },
    {
      name: "unhandled promise",
      source: "export function run() { Promise.resolve(); }",
      rule: "typescript(no-floating-promises)",
    },
    {
      name: "void does not handle rejection",
      source: "export function run() { void Promise.resolve(); }",
      rule: "typescript(no-floating-promises)",
    },
    {
      name: "async DOM callback",
      source:
        "export function Button() { return <button onClick={async () => { await Promise.resolve(); }}>Run</button>; }",
      rule: "typescript(no-misused-promises)",
    },
    {
      name: "unsafe assignment",
      source: 'export const value = JSON.parse("null");',
      rule: "typescript(no-unsafe-assignment)",
    },
    {
      name: "untracked Solid accessor",
      source:
        'import { createSignal } from "solid-js"; export function Counter() { const [count] = createSignal(0); const value = count(); return <p>{value}</p>; }',
      rule: "solid(reactivity)",
    },
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.name, () => {
      writeFileSync(file, fixture.source);
      const result = spawnSync(
        process.execPath,
        [oxlint, "--deny-warnings", "--format", "json", file],
        {
          cwd: web,
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.ifError(result.error);
      const report = JSON.parse(result.stdout);
      if (!fixture.rule) {
        assert.equal(result.status, 0, result.stdout + result.stderr);
        assert.equal(report.diagnostics.length, 0);
        return;
      }
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.ok(
        report.diagnostics.some(
          (diagnostic) => diagnostic.code === fixture.rule && diagnostic.severity === "error",
        ),
        `Expected ${fixture.rule}: ${result.stdout}${result.stderr}`,
      );
    });
  }
});
