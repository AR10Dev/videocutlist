import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect, Queue } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import { onCleanup } from "solid-js";
import type { Authentication, StreamingApiClient } from "../../api";
import type { ServerState } from "../../app/server";

/** One command per view: the native atom owns the transfer fiber and its result. */
export function createExportDownload(
  server: Pick<ServerState, "runtime" | "registry">,
  start: () => Effect.Effect<void, Error>,
) {
  const transfer = server.runtime.fn(start);
  const release = server.registry.mount(transfer);
  const result = useAtomValue(() => transfer);
  let closed = false;
  onCleanup(() => {
    closed = true;
    server.registry.set(transfer, Atom.Interrupt);
    release();
  });

  const pending = () => result().waiting;
  const error = () => {
    const current = result();
    if (current.waiting || !AsyncResult.isFailure(current)) return "";
    if (Cause.hasInterrupts(current.cause)) return "Download cancelled.";
    const cause = Cause.squash(current.cause);
    return cause instanceof Error ? cause.message : "Download failed. Try again.";
  };
  return {
    result: transfer,
    pending,
    error,
    download: () => {
      if (!closed && !server.registry.get(transfer).waiting)
        server.registry.set(transfer, undefined);
    },
    cancel: () => {
      if (!closed && server.registry.get(transfer).waiting)
        server.registry.set(transfer, Atom.Interrupt);
    },
  };
}

let registration:
  | { scriptUrl: string; scope: string; promise: Promise<ServiceWorkerRegistration> }
  | undefined;

function downloadWorker(mediaRoot: URL): Effect.Effect<ServiceWorker, Error> {
  return Effect.gen(function* () {
    if (!("serviceWorker" in navigator) || !window.isSecureContext)
      return yield* Effect.fail(
        new Error("Downloads require a secure browser context (HTTPS or localhost)."),
      );
    const scriptUrl = new URL(
      `${mediaRoot.pathname.slice(0, mediaRoot.pathname.lastIndexOf("/media/v2/"))}/download-sw.js`,
      window.location.origin,
    );
    scriptUrl.searchParams.set("mediaRoot", mediaRoot.href);
    const scope = `${scriptUrl.pathname.slice(0, scriptUrl.pathname.lastIndexOf("download-sw.js"))}download-stream/`;
    if (
      !registration ||
      registration.scriptUrl !== scriptUrl.href ||
      registration.scope !== scope
    ) {
      const state: {
        scriptUrl: string;
        scope: string;
        promise: Promise<ServiceWorkerRegistration>;
      } = {
        scriptUrl: scriptUrl.href,
        scope,
        promise: navigator.serviceWorker
          .register(scriptUrl.href, { scope, updateViaCache: "none" })
          .catch((error: unknown) => {
            if (registration === state) registration = undefined;
            throw error;
          }),
      };
      registration = state;
    }
    const selectedRegistration = registration!;
    const installed = yield* Effect.tryPromise({
      try: () => selectedRegistration.promise,
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Could not start the download worker. Try again."),
    });
    if (installed.scope !== new URL(scope, window.location.origin).href)
      return yield* Effect.fail(new Error("Configured download worker scope changed. Try again."));
    const worker = [installed.active, installed.installing, installed.waiting].find(
      (candidate) => candidate?.scriptURL === scriptUrl.href,
    );
    if (!worker)
      return yield* Effect.fail(new Error("Configured download worker is unavailable. Try again."));
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
    if (worker.scriptURL !== scriptUrl.href)
      return yield* Effect.fail(new Error("Configured download worker changed. Try again."));
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
): Effect.Effect<void, Error> {
  return Effect.scoped(
    Effect.gen(function* () {
      const mediaRoot = new URL(api.mediaUrl(""));
      const mediaMarker = "/media/v2/";
      if (
        (mediaRoot.protocol !== "https:" && mediaRoot.protocol !== "http:") ||
        mediaRoot.username ||
        mediaRoot.password ||
        mediaRoot.search ||
        mediaRoot.hash ||
        !mediaRoot.pathname.endsWith(mediaMarker) ||
        decodeURIComponent(mediaRoot.pathname) !== mediaRoot.pathname
      )
        return yield* Effect.fail(new Error("Could not determine the configured download root."));
      const rootPath = mediaRoot.pathname.slice(0, -"media/v2/".length);
      const worker = yield* downloadWorker(mediaRoot);
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
          api.reportUnauthorized(message.status, authentication, fiberSignal);
          return yield* Effect.fail(new Error(message.message ?? "Download failed. Try again."));
        } else if (message.type === "connection-lost") {
          return yield* Effect.fail(new Error("Download connection lost. Try again."));
        }
      }
    }),
  );
}

/** Stream an authenticated export through a same-origin download-only service worker. */
export function downloadExport(
  api: DownloadApi,
  path: string,
  name: string,
  authentication: Authentication,
): Effect.Effect<void, Error> {
  return Effect.suspend(() => streamDownload(api, api.mediaUrl(path), name, authentication));
}
