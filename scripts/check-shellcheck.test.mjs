import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const shellFiles = execFileSync(
  "find",
  ["scripts", "deployments", "test", "-type", "f", "-name", "*.sh"],
  {
    cwd: root,
    encoding: "utf8",
  },
)
  .trim()
  .split("\n");

function runLint(failFile) {
  const directory = mkdtempSync(join(tmpdir(), "videocutlist-lint-shellcheck-"));
  const bin = join(directory, "bin");
  const log = join(directory, "shellcheck.log");
  mkdirSync(bin);
  for (const command of ["node", "gofmt", "golangci-lint", "go", "shfmt", "pnpm"]) {
    const stub = join(bin, command);
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    chmodSync(stub, 0o755);
  }
  const shellcheck = join(bin, "shellcheck");
  writeFileSync(
    shellcheck,
    '#!/bin/sh\nprintf \'%s\\n\' "$1" >> "$SHELLCHECK_LOG"\n[ "$1" != "$SHELLCHECK_FAIL" ]\n',
  );
  chmodSync(shellcheck, 0o755);

  try {
    const result = spawnSync("make", ["lint"], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        SHELLCHECK_LOG: log,
        SHELLCHECK_FAIL: failFile ?? "",
      },
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
      checked: readFileSync(log, "utf8").trim().split("\n"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("lint fails on a non-final shellcheck error and still checks every script", () => {
  assert.ok(shellFiles.length > 1, "the regression requires multiple shell scripts");
  const result = runLint(shellFiles[0]);
  assert.notEqual(result.status, 0, result.output);
  assert.deepEqual(result.checked, shellFiles);
});

test("lint succeeds when shellcheck passes every script", () => {
  const result = runLint();
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.checked, shellFiles);
});
