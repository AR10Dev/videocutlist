import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export default async function setup() {
  const cwd = resolve("..");
  const directory = await mkdtemp(resolve(tmpdir(), "videocutlist-e2e-build-"));
  try {
    for (const tool of ["ffmpeg", "ffprobe"]) await run(tool, ["-version"]);
    await run("./test/harness/acquire-real-media.sh", [], { cwd, timeout: 150_000 });
    await run("make", ["build"], { cwd, timeout: 180_000, maxBuffer: 5 * 1024 * 1024 });
    process.env.VIDEOCUTLIST_E2E_BINARY = resolve(directory, "videocutlist");
    await run(
      "go",
      [
        "build",
        "-tags",
        "embed_frontend",
        "-o",
        process.env.VIDEOCUTLIST_E2E_BINARY,
        "./cmd/videocutlist",
      ],
      { cwd, timeout: 120_000 },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return async () => {
    await rm(directory, { recursive: true, force: true });
  };
}
