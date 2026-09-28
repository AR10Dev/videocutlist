// This worker controls only /download-stream/, never the application or API.
// Credentials and upstream URLs remain transient and never enter navigation URLs or storage.
const prefix = new URL("/download-stream/", self.location.origin).href;
const downloads = new Map();

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));

self.addEventListener("message", (event) => {
  const request = event.data;
  const port = event.ports[0];
  if (
    !port ||
    request?.type !== "download" ||
    typeof request.id !== "string" ||
    !/^[0-9a-f-]{36}$/.test(request.id) ||
    typeof request.url !== "string" ||
    typeof request.name !== "string" ||
    !["none", "cookie", "bearer"].includes(request.authentication?.type)
  )
    return;

  let url;
  try {
    url = new URL(request.url);
    if (url.protocol !== "https:" && url.protocol !== "http:") return;
  } catch {
    return;
  }

  const key = `${prefix}${request.id}`;
  const controller = new AbortController();
  let finish;
  const lifetime = new Promise((resolve) => {
    finish = resolve;
  });
  let stopped = false;
  const record = {
    response: null,
    name: request.name,
    controller,
    port,
    expiry: undefined,
    lastProgress: Date.now(),
    stop,
  };
  downloads.set(key, record);

  function stop(message, status) {
    if (stopped) return;
    stopped = true;
    if (downloads.get(key) === record) downloads.delete(key);
    clearTimeout(record.expiry);
    controller.abort();
    if (message) port.postMessage({ type: "error", message, status });
    port.close();
    finish();
  }

  port.onmessage = (message) => {
    if (message.data?.type === "cancel") stop("Download cancelled.");
  };
  event.waitUntil(lifetime);

  void (async () => {
    try {
      const headers = new Headers();
      if (request.authentication.type === "bearer")
        headers.set("Authorization", `Bearer ${request.authentication.token}`);
      const upstream = await fetch(url.href, {
        headers,
        credentials: request.authentication.type === "cookie" ? "include" : "omit",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!upstream.ok) {
        stop(`Download failed (${upstream.status}). Try again.`, upstream.status);
        return;
      }
      if (!upstream.body) throw new Error("Browser cannot stream this download.");
      record.response = upstream;
      record.expiry = setTimeout(() => stop("Download did not start. Try again."), 30_000);
      port.postMessage({ type: "ready" });
    } catch (error) {
      if (controller.signal.aborted) return;
      stop(
        error instanceof TypeError
          ? "Could not reach the export server. Check its CORS settings and try again."
          : error instanceof Error
            ? error.message
            : "Download failed. Try again.",
      );
    }
  })();
});

self.addEventListener("fetch", (event) => {
  if (!event.request.url.startsWith(prefix)) return;
  const record = downloads.get(event.request.url);
  if (!record || !record.response || event.request.method !== "GET") {
    event.respondWith(
      new Response("Download expired.", { status: 410, headers: { "Cache-Control": "no-store" } }),
    );
    return;
  }
  downloads.delete(event.request.url);
  clearTimeout(record.expiry);
  event.respondWith(streamDownload(record));
});

function streamDownload(record) {
  const { port, name, stop, response } = record;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(destination) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          destination.close();
          port.postMessage({ type: "done" });
          stop();
        } else {
          destination.enqueue(value);
          const now = Date.now();
          if (now - record.lastProgress >= 10_000) {
            record.lastProgress = now;
            port.postMessage({ type: "progress" });
          }
        }
      } catch {
        destination.error(new Error("Download interrupted."));
        stop("Download interrupted. Try again.");
      }
    },
    cancel() {
      stop("Download cancelled.");
    },
  });
  // Do not echo the upstream disposition: its name can contain untrusted paths.
  const asciiName = name.replace(/[^\x20-\x7e]|["\\/;]/g, "_") || "download";
  const encodedName = encodeURIComponent(name).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const length = response.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(body, { headers });
}
