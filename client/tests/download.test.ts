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
  const worker = { state: "activated", postMessage: vi.fn() };
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
    const api: StreamingApiClient = {
      url: (path) => `https://server.example/api/v1/${path}`,
      request: vi.fn(),
      assetRequest: vi.fn(),
      reportUnauthorized,
    };
    vi.stubGlobal("navigator", {
      serviceWorker: { register: vi.fn(async () => ({ active: worker })) },
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
    expect(message.url).toBe("https://server.example/api/v1/jobs/1/outputs/0");
    expect(message.authentication).toBe(authentication);
    send("ready");
    send("done");
    await transfer;
    expect(link.click).toHaveBeenCalledOnce();
    expect(link.href).toBe(`https://app.example/download-stream/${message.id}`);
    expect(link.href).not.toContain(authentication.token);
    expect(link.referrerPolicy).toBe("no-referrer");
    expect(pagePort.postMessage).not.toHaveBeenCalled();
    expect(pagePort.close).toHaveBeenCalledOnce();
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
