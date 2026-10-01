import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourcePath = resolve(clientRoot, "../docs/contracts/api.openapi.yaml");
const outputPath = resolve(clientRoot, "src/generated/effect-api.ts");
const nativeContentTypes = new Set([
  "application/zip",
  "image/png",
  "text/event-stream",
  "text/plain",
  "video/mp4",
]);
const nativeOperationIds = new Set([
  "metrics",
  "health",
  "ready",
  "streamPreview",
  "previewStatus",
  "downloadBatchOutputs",
  "downloadJobOutput",
  "observeJob",
  "observeBatch",
  "getThumbnails",
  "getWaveform",
  "exportInterchange",
]);

const spec = YAML.parse(await readFile(sourcePath, "utf8"));
const operationIds = new Set(
  Object.values(spec.paths).flatMap((pathItem) =>
    Object.values(pathItem)
      .filter((operation) => operation && typeof operation === "object")
      .map((operation) => operation.operationId)
      .filter(Boolean),
  ),
);
for (const required of ["listProjects", "putProject", "createExport", "getJob"]) {
  if (!operationIds.has(required)) throw new Error(`Missing required JSON operation: ${required}`);
}
for (const native of nativeOperationIds) {
  if (!operationIds.has(native)) throw new Error(`Missing documented native operation: ${native}`);
}
for (const pathItem of Object.values(spec.paths)) {
  for (const operation of Object.values(pathItem)) {
    if (!operation || typeof operation !== "object" || !operation.operationId) continue;
    const responseTypes = Object.values(operation.responses ?? {}).flatMap((response) =>
      Object.keys(response?.content ?? {}),
    );
    const hasBinaryResponse = JSON.stringify(operation.responses ?? {}).includes(
      '"format":"binary"',
    );
    if (
      (responseTypes.some((contentType) => nativeContentTypes.has(contentType)) ||
        hasBinaryResponse) &&
      !nativeOperationIds.has(operation.operationId)
    ) {
      throw new Error(`Native response has no explicit JSON boundary: ${operation.operationId}`);
    }
  }
}
for (const [path, pathItem] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(pathItem)) {
    if (
      ["get", "put", "post", "delete", "patch", "head", "options"].includes(method) &&
      nativeOperationIds.has(operation.operationId)
    ) {
      delete pathItem[method];
    }
  }
  if (
    !Object.keys(pathItem).some((key) =>
      ["get", "put", "post", "delete", "patch", "head", "options"].includes(key),
    )
  ) {
    delete spec.paths[path];
  }
}

const selectedOperationIds = new Set(
  Object.values(spec.paths).flatMap((pathItem) =>
    Object.values(pathItem)
      .filter((operation) => operation && typeof operation === "object")
      .map((operation) => operation.operationId)
      .filter(Boolean),
  ),
);
for (const native of nativeOperationIds) {
  if (selectedOperationIds.has(native))
    throw new Error(`Native operation selected for JSON generation: ${native}`);
}

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "videocutlist-openapi-"));
const selectedSpecPath = resolve(temporaryDirectory, "selected.openapi.yaml");
try {
  await writeFile(selectedSpecPath, YAML.stringify(spec));
  let generated = execFileSync(
    "pnpm",
    [
      "exec",
      "openapigen",
      "--spec",
      selectedSpecPath,
      "--format",
      "httpapi",
      "--name",
      "VideoCutListApi",
    ],
    {
      cwd: clientRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  // Effect Struct decoders ignore extra keys by default; preserve OpenAPI closed-object rules.
  const generatedApiClose = ".add(DefaultGroup) {}";
  if (generated.split(generatedApiClose).length !== 2) {
    throw new Error("Unexpected HttpApi output; refusing to omit strict JSON codec options.");
  }
  generated = generated.replace(
    generatedApiClose,
    `.annotate(HttpApi.PayloadParseOptions, { onExcessProperty: "error" })\n  .annotate(HttpApi.SuccessParseOptions, { onExcessProperty: "error" })\n  ${generatedApiClose}`,
  );
  await writeFile(outputPath, generated);
  execFileSync("pnpm", ["exec", "oxfmt", "--write", outputPath], {
    cwd: clientRoot,
    stdio: "inherit",
  });
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
