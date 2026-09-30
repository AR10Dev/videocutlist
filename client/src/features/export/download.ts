import { createSignal } from "solid-js";
import type { Authentication, StreamingApiClient } from "../../api";

/** Share the pending, error, and cancellation lifecycle of export download actions. */
export function createExportDownload(start: (signal: AbortSignal) => Promise<void>) {
  const [pending, setPending] = createSignal(false);
  const [error, setError] = createSignal("");
  let controller: AbortController | undefined;
  const download = async () => {
    if (pending()) return;
    const requestController = new AbortController();
    controller = requestController;
    setPending(true);
    setError("");
    try {
      await start(requestController.signal);
    } catch (cause) {
      if (requestController.signal.aborted) setError("Download cancelled.");
      else setError(cause instanceof Error ? cause.message : "Download failed. Try again.");
    } finally {
      controller = undefined;
      setPending(false);
    }
  };
  return { pending, error, download, cancel: () => controller?.abort() };
}

const scope = "/download-stream/";
let registration: Promise<ServiceWorkerRegistration> | undefined;

async function downloadWorker() {
  if (!("serviceWorker" in navigator) || !window.isSecureContext)
    throw new Error("Downloads require a secure browser context (HTTPS or localhost).");
  registration ??= navigator.serviceWorker
    .register("/download-sw.js", { scope, updateViaCache: "none" })
    .catch((error: unknown) => {
      registration = undefined;
      throw error;
    });
  const installed = await registration;
  const worker = installed.active ?? installed.installing ?? installed.waiting;
  if (!worker) throw new Error("Could not start the download worker. Try again.");
  if (worker.state !== "activated") {
    await new Promise<void>((resolve, reject) => {
      const onStateChange = () => {
        if (worker.state === "activated") {
          worker.removeEventListener("statechange", onStateChange);
          resolve();
        } else if (worker.state === "redundant") {
          worker.removeEventListener("statechange", onStateChange);
          reject(new Error("Download worker could not activate. Try again."));
        }
      };
      worker.addEventListener("statechange", onStateChange);
      onStateChange();
    });
  }
  return worker;
}

/** Stream an authenticated export through a same-origin download-only service worker. */
export async function downloadExport(
  api: StreamingApiClient,
  path: string,
  name: string,
  authentication: Authentication,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Download cancelled.", "AbortError");
  const url = api.url(path);
  const worker = await downloadWorker();
  if (signal?.aborted) throw new DOMException("Download cancelled.", "AbortError");

  const channel = new MessageChannel();
  const id = crypto.randomUUID();
  const downloadUrl = new URL(`${scope}${id}`, window.location.origin).href;
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(watchdog);
      channel.port1.close();
      signal?.removeEventListener("abort", cancel);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const cancel = () => {
      channel.port1.postMessage({ type: "cancel" });
      finish(new DOMException("Download cancelled.", "AbortError"));
    };
    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        channel.port1.postMessage({ type: "cancel" });
        finish(new Error("Download stalled. Try again."));
      }, 120_000);
    };
    channel.port1.onmessage = (
      event: MessageEvent<{ type: string; message?: string; status?: number }>,
    ) => {
      if (settled) return;
      if (event.data?.type === "ready") {
        const link = document.createElement("a");
        link.href = downloadUrl;
        link.referrerPolicy = "no-referrer";
        link.click();
      } else if (event.data?.type === "done") {
        finish();
      } else if (event.data?.type === "error") {
        api.reportUnauthorized(event.data.status, authentication, signal);
        finish(new Error(event.data.message ?? "Download failed. Try again."));
      } else if (event.data?.type === "progress") {
        watch();
      }
    };
    channel.port1.onmessageerror = () => finish(new Error("Download connection lost. Try again."));
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) {
      cancel();
      channel.port2.close();
      return;
    }
    watch();
    try {
      worker.postMessage({ type: "download", id, url, name, authentication }, [channel.port2]);
    } catch {
      finish(new Error("Could not start the download. Try again."));
    }
  });
}
