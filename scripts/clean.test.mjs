import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const outputs = [
  "web/dist/index.html",
  "internal/web/webassets/dist/index.html",
  "web/test-results/report.json",
  "web/playwright-report/index.html",
  "web/blob-report/report.zip",
  "web/coverage/report.json",
  "web/.vitest/results.json",
  "test-results/report.json",
  "playwright-report/index.html",
  "blob-report/report.zip",
  "coverage/report.json",
  "web/node_modules/.vite/cache.json",
  "web/node_modules/.vite-temp/cache.json",
  "node_modules/.vite/cache.json",
  "videocutlist",
  "videocutlist.exe",
  "backend.test",
  "build.tsbuildinfo",
  "web/build.tsbuildinfo",
];
const dependencies = [
  "node_modules/package/index.js",
  "web/node_modules/package/index.js",
  ".pnpm-store/package/index.js",
];
const disposable = [
  ".devenv/state",
  ".direnv/state",
  "test/fixtures/real-media/sintel-trailer.mp4",
  ".cache/real-ui/state",
  ".cache/real-ui.example/state",
  ".cache/ui-repro/state",
  ".cache/ui-repro-vite.log",
];
const preserved = [
  "web/src/main.tsx",
  "web/src/generated/effect-api.ts",
  "internal/db/migrations/schema.sql",
  "pnpm-lock.yaml",
  "web/pnpm-lock.yaml",
  ".git/config",
  ".agents/skills/example.md",
  ".scratch/spec.md",
  "devenv.local.nix",
  ".cache/videocutlist/videocutlist.db",
  ".cache/videocutlist/exports/video.mp4",
  ".cache/custom/state",
  "deployments/containers/data/videocutlist.db",
  "deployments/containers/media/original.mp4",
  "deployments/containers/exports/video.mp4",
  "deployments/containers/videocutlist.env",
];

for (const target of ["clean", "clean-deps", "clean-all"]) {
  test(`${target} removes only its documented artifacts and is repeatable`, () => {
    const directory = mkdtempSync(join(tmpdir(), "videocutlist-clean-"));
    try {
      copyFileSync(join(root, "Makefile"), join(directory, "Makefile"));
      for (const path of [...outputs, ...dependencies, ...disposable, ...preserved]) {
        mkdirSync(dirname(join(directory, path)), { recursive: true });
        writeFileSync(join(directory, path), "sentinel");
      }
      for (let run = 0; run < 2; run++) {
        execFileSync("make", [target], { cwd: directory, stdio: "pipe" });
        const removed = [
          ...outputs,
          ...(target !== "clean" ? dependencies : []),
          ...(target === "clean-all" ? disposable : []),
        ];
        const retained = [
          ...preserved,
          ...(target === "clean" ? dependencies : []),
          ...(target !== "clean-all" ? disposable : []),
        ];
        for (const path of removed) assert.equal(existsSync(join(directory, path)), false, path);
        for (const path of retained) assert.equal(existsSync(join(directory, path)), true, path);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
