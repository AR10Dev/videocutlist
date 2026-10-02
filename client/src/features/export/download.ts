import { useAtomSet, useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Queue } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { onCleanup } from "solid-js";
import { runEffect, type Authentication, type StreamingApiClient } from "../../api";

/** One command per view: the native atom owns the transfer fiber and its result. */
export function createExportDownload(start: (signal: AbortSignal) => Promise<void>) {
  const transfer = Atom.fn(() =>
    Effect.tryPromise({
      try: start,
      catch: (cause) => (cause instanceof Error ? cause : new Error("Download failed. Try again.")),
    }),
  );
  const result = useAtomValue(() => transfer);
  const run = useAtomSet(() => transfer, { mode: "promise" });
  const interrupt = useAtomSet(() => transfer);
  let active = false;
  onCleanup(() => interrupt(Atom.Interrupt));

  const pending = () => result().waiting;
  const error = () => {
    const current = result();
    if (current.waiting) return "";
    if (!AsyncResult.isFailure(current)) return "";
    if (Cause.hasInterrupts(current.cause)) return "Download cancelled.";
    const cause = Cause.squash(current.cause);
    return cause instanceof Error ? cause.message : "Download failed. Try again.";
  };
  const download = async () => {
    if (active) return;
    active = true;
    try {
      await run(undefined);
    } catch {
      // The atom retains the failure for the view; callers keep the Promise<void> contract.
    } finally {
      active = false;
    }
  };
  return {
    pending,
    error,
    download,
    cancel: () => {
      if (active) interrupt(Atom.Interrupt);
    },
  };
}

let registration: { rootPath: string; promise: Promise<ServiceWorkerRegistration> } | undefined;

function downloadWorker(rootPath: string): Effect.Effect<ServiceWorker, Error> {
  return Effect.gen(function* () {
    if (!("serviceWorker" in navigator) || !window.isSecureContext)
      return yield* Effect.fail(
        new Error("Downloads require a secure browser context (HTTPS or localhost)."),
      );
    const scope = `${rootPath}download-stream/`;
    if (!registration || registration.rootPath !== rootPath) {
      const state: { rootPath: string; promise: Promise<ServiceWorkerRegistration> } = {
        rootPath,
        promise: navigator.serviceWorker
          .register(`${rootPath}download-sw.js`, { scope, updateViaCache: "none" })
          .catch((error: unknown) => {
            if (registration === state) registration = undefined;
            throw error;
          }),
      };
      registration = state;
    }
    const installed = yield* Effect.tryPromise({
      try: () => registration!.promise,
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Could not start the download worker. Try again."),
    });
    const worker = installed.active ?? installed.installing ?? installed.waiting;
    if (!worker)
      return yield* Effect.fail(new Error("Could not start the download worker. Try again."));
    if (worker.state !== "activated") {
      yield* Effect.callback<void, Error>((resume) => {
        const onStateChange = () => {
          if (worker.state === "activated" || worker.state === "redundant") {
            worker.removeEventListener("statechange", onStateChange);
            resume(
              worker.state === "activated"
                ? Effect.void
                : Effect.fail(new Error("Download worker could not activate. Try again.")),
            );
          }
        };
        worker.addEventListener("statechange", onStateChange);
        onStateChange();
        return Effect.sync(() => worker.removeEventListener("statechange", onStateChange));
      });
    }
    return worker;
  });
}

type DownloadMessage = { type: string; message?: string; status?: number };
type DownloadApi = Pick<StreamingApiClient, "reportUnauthorized"> & {
  mediaUrl(relativePath: string): string;
};

function streamDownload(
  api: DownloadApi,
  url: string,
  name: string,
  authentication: Authentication,
  signal?: AbortSignal,
): Effect.Effect<void, Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      const mediaBase = new URL(api.mediaUrl(""));
      const mediaMarker = "/media/v2/";
      const mediaRoot = mediaBase.pathname.lastIndexOf(mediaMarker);
      if (mediaRoot < 0 || mediaBase.pathname.slice(mediaRoot) !== mediaMarker)
        return yield* Effect.fail(new Error("Could not determine the configured download root."));
      const rootPath = mediaBase.pathname.slice(0, mediaRoot + 1);
      const worker = yield* downloadWorker(rootPath);
      const fiberSignal = yield* Effect.abortSignal;
      const messages = yield* Queue.unbounded<DownloadMessage>();
      const id = crypto.randomUUID();
      const downloadUrl = new URL(`${rootPath}download-stream/${id}`, window.location.origin).href;
      let posted = false;
      let completed = false;
      const channel = yield* Effect.acquireRelease(
        Effect.sync(() => new MessageChannel()),
        (channel: MessageChannel) =>
          Effect.sync(() => {
            // A failed or interrupted page fiber must stop the worker's upstream fetch.
            if (posted && !completed) {
              try {
                channel.port1.postMessage({ type: "cancel" });
              } catch {
                // The worker may already have closed its end of the channel.
              }
            }
            channel.port1.onmessage = null;
            channel.port1.onmessageerror = null;
            channel.port1.close();
            channel.port2.close();
          }),
      );
      channel.port1.onmessage = (event: MessageEvent<DownloadMessage>) => {
        if (!fiberSignal.aborted) Queue.offerUnsafe(messages, event.data);
      };
      channel.port1.onmessageerror = () => {
        if (!fiberSignal.aborted) Queue.offerUnsafe(messages, { type: "connection-lost" });
      };
      yield* Effect.try({
        try: () => {
          worker.postMessage({ type: "download", id, url, name, authentication }, [channel.port2]);
          posted = true;
        },
        catch: () => new Error("Could not start the download. Try again."),
      });

      let deadline = Date.now() + 120_000;
      while (true) {
        const message = yield* Effect.raceFirst(
          Queue.take(messages),
          Effect.sleep(Math.max(0, deadline - Date.now())).pipe(
            Effect.as({ type: "timeout" } as const),
          ),
        );
        if (message.type === "timeout")
          return yield* Effect.fail(new Error("Download stalled. Try again."));
        if (message.type === "progress") {
          deadline = Date.now() + 120_000;
        } else if (message.type === "ready") {
          yield* Effect.try({
            try: () => {
              const link = document.createElement("a");
              link.href = downloadUrl;
              link.referrerPolicy = "no-referrer";
              link.click();
            },
            catch: () => new Error("Could not start the download. Try again."),
          });
        } else if (message.type === "done") {
          completed = true;
          return;
        } else if (message.type === "error") {
          completed = true;
          api.reportUnauthorized(message.status, authentication, signal ?? fiberSignal);
          return yield* Effect.fail(new Error(message.message ?? "Download failed. Try again."));
        } else if (message.type === "connection-lost") {
          return yield* Effect.fail(new Error("Download connection lost. Try again."));
        }
      }
    }),
  );
}

/** Stream an authenticated export through a same-origin download-only service worker. */
export async function downloadExport(
  api: DownloadApi,
  path: string,
  name: string,
  authentication: Authentication,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Download cancelled.", "AbortError");
  const url = api.mediaUrl(path);
  try {
    await runEffect(streamDownload(api, url, name, authentication, signal), signal);
  } catch (cause) {
    if (signal?.aborted) throw new DOMException("Download cancelled.", "AbortError");
    throw cause;
  }
}
