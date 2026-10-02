import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { StreamingApiClient } from "../src/api";
import { createExportDownload, downloadExport } from "../src/features/export/download";

const owners: Array<() => void> = [];
afterEach(() => {
  for (const dispose of owners.splice(0)) dispose();
  vi.unstubAllGlobals();
});

function ownedDownload(start: (signal: AbortSignal) => Promise<void>) {
  return createRoot((dispose) => {
    owners.push(dispose);
    return createExportDownload(start);
  });
}

describe("export download actions", () => {
  it("allows only one active transfer and clears a failed transfer before retrying", async () => {
    let rejectTransfer!: (cause: unknown) => void;
    let finishTransfer!: () => void;
    let attempts = 0;
    const action = ownedDownload(
      () =>
        new Promise<void>((resolve, reject) => {
          attempts++;
          rejectTransfer = reject;
          finishTransfer = resolve;
        }),
    );
    const transfer = action.download();
    expect(action.pending()).toBe(true);
    await action.download();
    expect(attempts).toBe(1);
    rejectTransfer(new Error("Output expired."));
    await transfer;
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("Output expired.");

    const retry = action.download();
    expect(action.pending()).toBe(true);
    expect(action.error()).toBe("");
    expect(attempts).toBe(2);
    finishTransfer();
    await retry;
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("");
  });

  it("cancels the active transfer without leaving the next transfer cancelled", async () => {
    const signals: AbortSignal[] = [];
    const action = ownedDownload(
      (signal) =>
        new Promise<void>((_, reject) => {
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    const transfer = action.download();
    action.cancel();
    await transfer;
    expect(signals[0].aborted).toBe(true);
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("Download cancelled.");

    action.cancel();
    const retry = action.download();
    expect(signals[1].aborted).toBe(false);
    expect(action.pending()).toBe(true);
    expect(action.error()).toBe("");
    action.cancel();
    await retry;
    expect(signals[1].aborted).toBe(true);
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("Download cancelled.");
  });

  it("interrupts the transfer when its browser owner is disposed", async () => {
    let signal!: AbortSignal;
    const action = ownedDownload(
      (current) =>
        new Promise<void>((_, reject) => {
          signal = current;
          current.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    const transfer = action.download();
    expect(action.pending()).toBe(true);
    owners.pop()!();
    await transfer;
    expect(signal.aborted).toBe(true);
  });
});

describe("service worker transfer", () => {
  const worker = { state: "activated", scriptURL: "", postMessage: vi.fn() };
  function browser() {
    const link = { href: "", referrerPolicy: "", click: vi.fn() };
    const pagePort = {
      onmessage: null as ((event: MessageEvent<{ type: string; status?: number }>) => void) | null,
      onmessageerror: null as (() => void) | null,
      postMessage: vi.fn(),
      close: vi.fn(),
    };
    const workerPort = { close: vi.fn() };
    worker.postMessage.mockClear();
    const reportUnauthorized = vi.fn();
    const api: StreamingApiClient & { mediaUrl(relativePath: string): string } = {
      url: (path) => `https://server.example/deploy/api/v2/${path}`,
      mediaUrl: (path) => `https://server.example/deploy/media/v2/${path}`,
      request: vi.fn(),
      assetRequest: vi.fn(),
      reportUnauthorized,
    };
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn(async (scriptURL: string, options: RegistrationOptions) => {
          worker.scriptURL = scriptURL;
          return {
            active: worker,
            scope: new URL(options.scope ?? "/", window.location.origin).href,
          };
        }),
      },
    });
    vi.stubGlobal("window", { isSecureContext: true, location: { origin: "https://app.example" } });
    vi.stubGlobal("document", { createElement: vi.fn(() => link) });
    vi.stubGlobal(
      "MessageChannel",
      class {
        port1 = pagePort;
        port2 = workerPort;
      },
    );
    const send = (type: string, status?: number) => {
      pagePort.onmessage?.({
        data: { type, status },
      } as MessageEvent<{ type: string; status?: number }>);
    };
    return { api, worker, pagePort, workerPort, link, reportUnauthorized, send };
  }

  it("navigates only the opaque download URL and closes the channel after streaming", async () => {
    const { api, worker, pagePort, link, send } = browser();
    const authentication = { type: "bearer" as const, token: "private-token" };
    const transfer = downloadExport(api, "jobs/1/outputs/0", "clip.mp4", authentication);
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    const [message] = worker.postMessage.mock.calls[0] as unknown as [
      { url: string; authentication: typeof authentication; id: string },
    ];
    expect(message.url).toBe("https://server.example/deploy/media/v2/jobs/1/outputs/0");
    expect(worker.postMessage).toHaveBeenCalledWith(expect.objectContaining({ url: message.url }), [
      expect.any(Object),
    ]);
    expect(navigator.serviceWorker.register).toHaveBeenCalledWith(
      "https://app.example/deploy/download-sw.js?mediaRoot=https%3A%2F%2Fserver.example%2Fdeploy%2Fmedia%2Fv2%2F",
      { scope: "/deploy/download-stream/", updateViaCache: "none" },
    );
    expect(message.authentication).toBe(authentication);
    send("ready");
    send("done");
    await transfer;
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.href).toBe(`https://app.example/deploy/download-stream/${message.id}`);
    expect(link.href).not.toContain(authentication.token);
    expect(link.referrerPolicy).toBe("no-referrer");
    expect(pagePort.postMessage).not.toHaveBeenCalled();
    expect(pagePort.close).toHaveBeenCalledOnce();
  });

  it("rejects a reused worker whose immutable configured root does not match", async () => {
    const { api, worker } = browser();
    api.mediaUrl = (path) => `https://other-server.example/other/media/v2/${path}`;
    vi.mocked(navigator.serviceWorker.register).mockResolvedValueOnce({
      active: {
        ...worker,
        scriptURL: "https://app.example/other/download-sw.js?mediaRoot=stale",
      } as unknown as ServiceWorker,
      scope: "https://app.example/other/download-stream/",
    } as ServiceWorkerRegistration);
    await expect(
      downloadExport(api, "jobs/1/outputs/0", "clip.mp4", { type: "none" }),
    ).rejects.toThrow("Configured download worker is unavailable.");
    expect(worker.postMessage).not.toHaveBeenCalled();
  });

  it("interrupts the worker entry and ignores an unauthorized message after cancellation", async () => {
    const { api, worker, pagePort, reportUnauthorized, send } = browser();
    const controller = new AbortController();
    const transfer = downloadExport(
      api,
      "jobs/1/outputs/0",
      "clip.mp4",
      { type: "none" },
      controller.signal,
    );
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledOnce());
    const lateMessage = pagePort.onmessage;
    controller.abort();
    await expect(transfer).rejects.toMatchObject({ name: "AbortError" });
    expect(pagePort.postMessage).toHaveBeenCalledWith({ type: "cancel" });
    expect(pagePort.close).toHaveBeenCalledOnce();
    lateMessage?.({
      data: { type: "error", status: 401 },
    } as MessageEvent<{ type: string; status: number }>);
    send("error", 401);
    expect(reportUnauthorized).not.toHaveBeenCalled();
  });
});

function actualDownloadWorker(scriptUrl: string) {
  const listeners = new Map<string, (event: unknown) => void>();
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(new ReadableStream()));
  const serviceWorker = {
    location: { href: scriptUrl, origin: "https://app.example" },
    registration: { scope: "https://app.example/deploy/download-stream/" },
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    skipWaiting: vi.fn(),
  };
  runInNewContext(readFileSync(new URL("../public/download-sw.js", import.meta.url), "utf8"), {
    self: serviceWorker,
    fetch,
    URL,
    Headers,
    Response,
    ReadableStream,
    AbortController,
    setTimeout,
    clearTimeout,
  });
  return { fetch, listeners };
}

describe("download service worker origin confinement", () => {
  const root = "https://server.example/deploy/media/v2/";
  const script = `https://app.example/deploy/download-sw.js?mediaRoot=${encodeURIComponent(root)}`;
  const validPath = "https://server.example/deploy/media/v2/jobs/job_123/outputs/0";

  function message(url: string) {
    const port = {
      close: vi.fn(),
      postMessage: vi.fn(),
      onmessage: null as null | ((event: MessageEvent) => void),
    };
    return {
      data: {
        type: "download",
        id: "b321a7b3-1a95-4e4f-9ca7-151d48123023",
        name: "video.mp4",
        url,
        authentication: { type: "bearer", token: "secret-token" },
      },
      source: { url: "https://app.example/deploy/editor" },
      ports: [port],
      waitUntil: vi.fn(),
      port,
    };
  }

  it.each([
    ["off-origin", "https://attacker.example/outside/media/v2/jobs/job_123/outputs/0"],
    ["wrong deployment prefix", "https://server.example/wrong/media/v2/jobs/job_123/outputs/0"],
    [
      "encoded traversal",
      "https://server.example/deploy/media/v2/jobs/job_123%2F..%2F..%2Fattacker/outputs/0",
    ],
    [
      "normalized traversal",
      "https://server.example/deploy/media/v2/jobs/../jobs/job_123/outputs/0",
    ],
    ["root escape", "https://server.example/deploy/media/v20/jobs/job_123/outputs/0"],
  ])("rejects %s without fetching or forwarding credentials", (_case, url) => {
    const worker = actualDownloadWorker(script);
    const event = message(url);
    worker.listeners.get("message")!(event);
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(event.port.close).toHaveBeenCalledOnce();
  });

  it.each([
    ["missing", "https://app.example/deploy/download-sw.js"],
    [
      "malformed",
      "https://app.example/deploy/download-sw.js?mediaRoot=https%3A%2F%2Fserver.example%2Fwrong%2F",
    ],
    [
      "credentials",
      `https://app.example/deploy/download-sw.js?mediaRoot=${encodeURIComponent("https://user:pass@server.example/deploy/media/v2/")}`,
    ],
    [
      "traversal",
      `https://app.example/deploy/download-sw.js?mediaRoot=${encodeURIComponent("https://server.example/deploy/../deploy/media/v2/")}`,
    ],
  ])("fails closed with %s immutable root configuration", (_case, scriptUrl) => {
    const worker = actualDownloadWorker(scriptUrl);
    const event = message(validPath);
    worker.listeners.get("message")!(event);
    expect(worker.fetch).not.toHaveBeenCalled();
    expect(event.port.close).toHaveBeenCalledOnce();
  });

  it("fetches a valid prefixed cross-origin URL only from the configured origin and root", async () => {
    const worker = actualDownloadWorker(script);
    const event = message(validPath);
    worker.listeners.get("message")!(event);
    await vi.waitFor(() => expect(worker.fetch).toHaveBeenCalledOnce());
    expect(worker.fetch).toHaveBeenCalledWith(
      validPath,
      expect.objectContaining({
        headers: expect.any(Headers),
        credentials: "omit",
        redirect: "error",
      }),
    );
    const init = worker.fetch.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret-token");
    event.port.onmessage?.({ data: { type: "cancel" } } as MessageEvent);
    await event.waitUntil.mock.calls[0]?.[0];
    expect(event.port.close).toHaveBeenCalledOnce();
  });
});
