import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";

const container = process.argv[2];
const base = process.env.VIDEOCUTLIST_TEST_URL;
const headers = { Authorization: `Bearer ${process.env.VIDEOCUTLIST_TEST_TOKEN}` };
async function request(path, method = "GET", body, status = 200) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, "Content-Type": "application/json", "Idempotency-Key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  assert.equal(response.status, status, `${method} ${path}: ${await response.clone().text()}`);
  return response;
}
async function json(path, method, body, status) {
  return (await request(path, method, body, status)).json();
}
async function waitFor(check) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await setTimeout(250);
  }
  assert.fail("Container workload timed out");
}
async function ready() {
  await waitFor(async () => {
    try {
      return (await fetch(`${base}/ready`, { signal: AbortSignal.timeout(1000) })).ok;
    } catch {
      return false;
    }
  });
}
function probe(bytes) {
  const result = JSON.parse(execFileSync("podman", ["exec", "-i", container,
    "ffprobe", "-v", "error", "-count_frames", "-show_streams", "-of", "json", "pipe:0"], { input: bytes }));
  assert.ok(result.streams.some((stream) => stream.codec_type === "video"));
  assert.ok(result.streams.some((stream) => stream.codec_type === "audio"));
  assert.ok(result.streams.every((stream) => Number(stream.nb_read_frames) > 0));
}

await ready();
assert.equal((await fetch(`${base}/api/v2/media`)).status, 401);
const media = await waitFor(async () => (await json("/api/v2/media")).items?.[0]);
assert.equal(media.name, "clip.mp4");
const preview = `/media/v2/media/${media.id}/preview?centerMs=2000&beforeMs=1000&afterMs=1000`;
const initial = await request(preview);
assert.equal(initial.headers.get("X-Preview-Cache"), "miss");
probe(Buffer.from(await initial.arrayBuffer()));
assert.equal((await request(preview, "HEAD")).headers.get("X-Preview-Cache"), "hit");

const path = "/api/v2/projects/p_container_smoke";
const item = {
  id: "i_abcdefghijklmnopqrstuvwx", mediaId: media.id,
  segments: [
    { startMs: 100, endMs: 900 },
    { startMs: 1200, endMs: 2100, included: true },
    { startMs: 2500, endMs: 3000, included: false },
  ],
};
let saved = await json(path, "PUT", { revision: 0, schemaVersion: 2, name: "Container smoke", items: [item] });
assert.deepEqual((await json(path)).items[0].segments.map((s) => s.included), [true, true, false]);
const jobs = [];
for (const [mode, cutStrategy] of [
  ["merge", "precise_reencode"], ["separate", "precise_reencode"],
  ["merge", "stream_copy_preferred"], ["separate", "stream_copy_preferred"],
]) {
  item.exportOptions = { mode, cutStrategy, container: "mkv", destinationId: "download" };
  saved = await json(path, "PUT", { revision: saved.revision, schemaVersion: 2, name: saved.name, items: [item] });
  const submitted = await json(`${path}/exports`, "POST", { projectRevision: saved.revision }, 202);
  assert.equal(submitted.jobs.length, 1);
  const job = await waitFor(async () => {
    const current = await json(`/api/v2/jobs/${submitted.jobs[0].id}`);
    assert.ok(!["failed", "cancelled"].includes(current.state), JSON.stringify(current));
    return current.state === "succeeded" && current;
  });
  jobs.push(job.id);
  const count = mode === "merge" ? 1 : 2;
  assert.equal(job.result.outputNames?.length ?? (job.result.outputName ? 1 : 0), count);
  for (let position = 0; position < count; position++) {
    const output = await request(`/media/v2/jobs/${job.id}/outputs/${position}`);
    probe(Buffer.from(await output.arrayBuffer()));
  }
}
// Ensure the database, published outputs, and cached previews outlive the process.
execFileSync("podman", ["restart", container]);
await ready();
assert.deepEqual((await json(path)).items[0].segments.map((s) => s.included), [true, true, false]);
assert.equal((await json(path)).revision, saved.revision);
assert.equal((await request(preview, "HEAD")).headers.get("X-Preview-Cache"), "hit");
for (const id of jobs) {
  assert.equal((await json(`/api/v2/jobs/${id}`)).state, "succeeded");
  probe(Buffer.from(await (await request(`/media/v2/jobs/${id}/outputs/0`)).arrayBuffer()));
}
execFileSync("podman", ["exec", container, "sh", "-ec", `
  test -s /var/lib/videocutlist/data/videocutlist.db
  test -z "$(find /var/cache/videocutlist/previews /var/lib/videocutlist/exports -name '*.partial' -print)"
`]);
console.log("PASS: bearer auth, media scan, preview miss/hit, merge/separate reencode and stream copy, save/reload defaults, restart persistence");
