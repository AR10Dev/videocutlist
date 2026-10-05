import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { gzipSync } from "node:zlib";

for (const root of process.argv.slice(2).map((path) => resolve(path))) {
  const tracked = execFileSync("git", ["-C", root, "ls-files", "client/src"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n");
  const lines = (files) =>
    files.reduce(
      (sum, file) => sum + readFileSync(resolve(root, file), "utf8").trimEnd().split("\n").length,
      0,
    );
  const infrastructure = [
    "client/src/api.ts",
    "client/src/features/app/server.ts",
    "client/src/features/queue/jobStream.ts",
  ].filter((file) => existsSync(resolve(root, file)));
  const assets = resolve(root, "client/dist/assets");
  const js = readdirSync(assets).filter((file) => file.endsWith(".js"));
  console.log(
    JSON.stringify(
      {
        root,
        handwrittenTypeScriptLines: lines(
          tracked.filter(
            (file) =>
              /\.tsx?$/.test(file) &&
              !file.includes("/generated/") &&
              !/\.(test|spec)\.tsx?$/.test(file),
          ),
        ),
        selectedInfrastructureFiles: infrastructure,
        selectedInfrastructureLines: lines(infrastructure),
        javaScriptBytes: js.reduce((sum, file) => sum + statSync(resolve(assets, file)).size, 0),
        javaScriptGzipBytes: js.reduce(
          (sum, file) => sum + gzipSync(readFileSync(resolve(assets, file))).length,
          0,
        ),
      },
      null,
      2,
    ),
  );
}
