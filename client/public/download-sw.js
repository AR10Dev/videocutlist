// This worker controls only its registered deployment-root download path.
// Credentials and upstream URLs remain transient and never enter navigation URLs or storage.
const prefix = new URL(self.registration.scope);
const mediaRoot = configuredMediaRoot();
const downloads = new Map();

function configuredMediaRoot() {
  try {
    const script = new URL(self.location.href);
    const values = script.searchParams.getAll("mediaRoot");
    if (
      script.hash ||
      [...script.searchParams.keys()].join(",") !== "mediaRoot" ||
      values.length !== 1
    )
      return undefined;
    const root = new URL(values[0]);
    if (
      values[0] !== root.href ||
      (root.protocol !== "https:" && root.protocol !== "http:") ||
      root.username ||
      root.password ||
      root.search ||
      root.hash ||
      !root.pathname.endsWith("/media/v2/") ||
      decodeURIComponent(root.pathname) !== root.pathname
    )
      return undefined;
    return root;
  } catch {
    return undefined;
  }
}

self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));

self.addEventListener("message", (event) => {
  const request = event.data;
  const port = event.ports.length === 1 ? event.ports[0] : undefined;
  if (
    !port ||
    event.source?.url == null ||
    !request ||
    Object.keys(request).sort().join(",") !== "authentication,id,name,type,url" ||
    request.type !== "download" ||
    typeof request.url !== "string" ||
    typeof request.id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.id) ||
    typeof request.name !== "string" ||
    request.name.length > 255 ||
    !request.name ||
    /[\\/\\"\x00-\x1f\x7f]/.test(request.name) ||
    !request.authentication ||
    !["none", "cookie", "bearer"].includes(request.authentication.type) ||
    (request.authentication.type === "bearer" &&
      (typeof request.authentication.token !== "string" ||
        !request.authentication.token ||
        /[\x00-\x1f\x7f]/.test(request.authentication.token))) ||
    (request.authentication.type === "bearer" &&
      Object.keys(request.authentication).sort().join(",") !== "token,type") ||
    (request.authentication.type !== "bearer" &&
      Object.keys(request.authentication).join(",") !== "type")
  ) {
    port?.close();
    return;
  }

  let url;
  try {
    const source = new URL(event.source.url);
    if (
      source.origin !== self.location.origin ||
      !source.pathname.startsWith(
        prefix.pathname.slice(0, prefix.pathname.lastIndexOf("download-stream/")),
      )
    ) {
      port.close();
      return;
    }
    url = new URL(request.url);
    const mediaPath = url.pathname.slice(mediaRoot?.pathname.length ?? 0);
    if (
      !mediaRoot ||
      url.origin !== mediaRoot.origin ||
      !url.pathname.startsWith(mediaRoot.pathname) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.href !== request.url ||
      !/^(jobs\/[A-Za-z0-9_-]+\/outputs\/[0-9]+|batches\/[A-Za-z0-9_-]+\/download)$/.test(
        mediaPath,
      ) ||
      decodeURIComponent(url.pathname) !== url.pathname
    ) {
      port.close();
      return;
    }
  } catch {
    port.close();
    return;
  }

  const key = `${prefix.href}${request.id}`;
  const controller = new AbortController();
  let finish;
  const lifetime = new Promise((resolve) => {
    finish = resolve;
  });
  let stopped = false;
  const record = {
    response: null,
    reader: null,
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
    if (record.reader)
      void record.reader
        .cancel()
        .catch(() => {})
        .finally(() => record.reader.releaseLock());
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
        redirect: "error",
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
  const destination = new URL(event.request.url);
  if (
    destination.origin !== prefix.origin ||
    !destination.pathname.startsWith(prefix.pathname) ||
    destination.search ||
    destination.hash
  )
    return;
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
  record.reader = reader;
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
    "Content-Type": response.headers.get("Content-Type") || "application/octet-stream",
    "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  const length = response.headers.get("Content-Length");
  if (length) headers.set("Content-Length", length);
  return new Response(body, { headers });
}
