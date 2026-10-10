import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkLayout, requiredFiles } from "./check-layout.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "videocutlist-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const add = (path) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
  };
  requiredFiles.forEach(add);
  return { root, add };
}

test("accepts the adopted layout and ignores dependency/build sources", (t) => {
  const { root, add } = fixture(t);
  [
    "internal/db/store.go",
    "test/harness/main.go",
    "node_modules/tool/go.mod",
    "web/dist/main.go",
  ].forEach(add);
  assert.equal(requiredFiles.some((path) => path.endsWith(".md")), false);
  assert.deepEqual(checkLayout(root), []);
});

test("rejects retired paths, misplaced Go sources and nested modules", (t) => {
  const { root, add } = fixture(t);
  [
    "client/package.json",
    "docs/contracts/old.yaml",
    "src/main.go",
    "web/main.go",
    "internal/service/go.mod",
  ].forEach(add);
  const problems = checkLayout(root);
  assert.ok(problems.includes("Retired layout: client"));
  assert.ok(problems.includes("Retired layout: docs/contracts"));
  assert.ok(problems.includes("Retired layout: src"));
  assert.ok(problems.includes("Go source belongs in cmd/, internal/ or test/: web/main.go"));
  assert.ok(problems.includes("Nested Go module: internal/service/go.mod"));
});

test("rejects missing contract and entry point files", (t) => {
  const { root } = fixture(t);
  rmSync(join(root, "api/api.openapi.yaml"));
  rmSync(join(root, "web/src/main.tsx"));
  assert.deepEqual(checkLayout(root), [
    "Missing required file: api/api.openapi.yaml",
    "Missing required file: web/src/main.tsx",
  ]);
});
