import { runEffect } from "./runEffect";
import { Cause, Effect, Exit } from "effect";
import * as Atom from "effect/reactivity/Atom";
import * as AtomRegistry from "effect/reactivity/AtomRegistry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, MAX_INTERCHANGE_FILE_BYTES } from "../src/api";
import { createServerState } from "../src/app/server";
import {
  MAX_INTERCHANGE_ATTACHMENT_BYTES,
  readInterchangeAttachment,
  readInterchangeFile,
  downloadInterchangeAttachment,
} from "../src/features/projects/interchange";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const configuration = {
  serverBaseUrl: "https://example.test/deploy",
  authentication: { type: "bearer" as const, token: "private-token" },
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((resume) => (resolve = resume));
  return { promise, resolve };
};

const streamedFile = (body: ReadableStream<Uint8Array<ArrayBuffer>>, size = 0) => {
  const file = new Blob();
  Object.defineProperty(file, "size", { value: size });
  vi.spyOn(file, "stream").mockReturnValue(body);
  return file;
};

const blockedFile = () => {
  const started = deferred();
  const cancelled = deferred();
  const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("partial"));
    },
    pull() {
      started.resolve();
      return new Promise<void>(() => undefined);
    },
    cancel: vi.fn(() => cancelled.resolve()),
  });
  const cancel = vi.spyOn(body, "cancel");
  return { body, file: streamedFile(body), started, cancelled, cancel };
};

describe("readInterchangeFile", () => {
  it("reads exactly 1 MiB of UTF-8 bytes, independent of UTF-16 length", async () => {
    const text = "🎬".repeat(MAX_INTERCHANGE_FILE_BYTES / 4);
    const file = new Blob([text]);
    expect(file.size).toBe(MAX_INTERCHANGE_FILE_BYTES);
    expect(file.size).toBeGreaterThan(text.length);
    const reading = readInterchangeFile(file);
    await expect(runEffect(reading)).resolves.toBe(text);
  });

  it.each([MAX_INTERCHANGE_FILE_BYTES + 1, -1, NaN, Infinity])(
    "rejects declared invalid size %s before opening a native stream",
    async (size) => {
      const file = new Blob();
      Object.defineProperty(file, "size", { value: size });
      const stream = vi.spyOn(file, "stream");
      await expect(runEffect(readInterchangeFile(file))).rejects.toThrow("1 MiB");
      expect(stream).not.toHaveBeenCalled();
    },
  );

  it("bounds streamed bytes even when the declared size is within the cap", async () => {
    const cancelSource = vi.fn(() => Promise.reject(new Error("Cancellation failed.")));
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INTERCHANGE_FILE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel: cancelSource,
    });
    const cancel = vi.spyOn(body, "cancel");
    const file = streamedFile(body, MAX_INTERCHANGE_FILE_BYTES);
    await expect(runEffect(readInterchangeFile(file))).rejects.toThrow("1 MiB");
    expect(cancel).toHaveBeenCalledOnce();
    expect(cancelSource).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("decodes split multibyte chunks and flushes an incomplete final sequence", async () => {
    const encoded = new TextEncoder().encode("A🎬é");
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      start(controller) {
        for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
        controller.enqueue(new Uint8Array([0xe2, 0x82]));
        controller.close();
      },
    });
    const cancel = vi.spyOn(body, "cancel");
    const file = streamedFile(body, encoded.byteLength + 2);
    // The same Effect can be executed again without sharing decoder or byte-count state.
    const reading = readInterchangeFile(file);
    await expect(runEffect(reading)).resolves.toBe("A🎬é�");
    expect(cancel).not.toHaveBeenCalled();
    expect(body.locked).toBe(false);
    vi.mocked(file.stream).mockReturnValue(new Blob(["second"]).stream());
    await expect(runEffect(reading)).resolves.toBe("second");
  });

  it("preserves native read errors and releases the reader after cancellation", async () => {
    const failure = new Error("Native read failed.");
    const body = new ReadableStream<Uint8Array<ArrayBuffer>>({
      pull(controller) {
        controller.error(failure);
      },
    });
    const cancel = vi.spyOn(body, "cancel");
    await expect(runEffect(readInterchangeFile(streamedFile(body)))).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("does not publish text or retain a reader when execution is already interrupted", async () => {
    const body = new Blob(["partial"]).stream();
    const file = streamedFile(body);
    const cancel = vi.spyOn(body, "cancel");
    const publish = vi.fn();
    const abort = new AbortController();
    abort.abort();
    const exit = await Effect.runPromiseExit(
      readInterchangeFile(file).pipe(Effect.tap((text) => Effect.sync(() => publish(text)))),
      { signal: abort.signal },
    );
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("interrupts a blocked read without publishing partial text or retaining signal listeners", async () => {
    const native = blockedFile();
    const abort = new AbortController();
    const add = vi.spyOn(abort.signal, "addEventListener");
    const remove = vi.spyOn(abort.signal, "removeEventListener");
    const published: string[] = [];
    const reading = Effect.runPromiseExit(
      readInterchangeFile(native.file).pipe(
        Effect.tap((text) => Effect.sync(() => published.push(text))),
      ),
      { signal: abort.signal },
    );
    try {
      await native.started.promise;
      expect(native.body.locked).toBe(true);
      abort.abort();
      const exit = await reading;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(published).toEqual([]);
      expect(native.cancel).toHaveBeenCalledOnce();
      expect(native.body.locked).toBe(false);
      for (const [event, listener] of add.mock.calls)
        expect(remove).toHaveBeenCalledWith(event, listener);
    } finally {
      abort.abort();
      await reading;
    }
  });

  it.each(["interrupt", "dispose", "supersede"] as const)(
    "cleans up a reader on workspace command %s with no late publication",
    async (operation) => {
      const configuration = {
        serverBaseUrl: "https://example.test",
        authentication: { type: "none" as const },
      };
      const registry = AtomRegistry.make();
      const server = createServerState(createApiClient(configuration), registry, configuration);
      const published: string[] = [];
      const command = server.runtime.fn((file: Blob) =>
        readInterchangeFile(file).pipe(
          Effect.tap((text) => Effect.sync(() => published.push(text))),
        ),
      );
      const release = registry.mount(command);
      const native = blockedFile();
      try {
        registry.set(command, native.file);
        await native.started.promise;
        if (operation === "dispose") registry.dispose();
        else if (operation === "interrupt") registry.set(command, Atom.Interrupt);
        else registry.set(command, new Blob(["replacement"]));
        await native.cancelled.promise;
        expect(native.body.locked).toBe(false);
        expect(native.cancel).toHaveBeenCalledOnce();
        if (operation === "supersede") {
          await expect(
            runEffect(AtomRegistry.getResult(registry, command, { suspendOnWaiting: true })),
          ).resolves.toBe("replacement");
          expect(published).toEqual(["replacement"]);
        } else expect(published).toEqual([]);
      } finally {
        release();
        registry.dispose();
      }
    },
  );
});

describe("project interchange attachments", () => {
  it("uses the configured native media root, central auth policy and attachment headers", async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe(
        "https://example.test/deploy/media/v2/projects/p_aaaaaaaaaaaa/interchange/csv?itemId=i_bbbbbbbbbbbbbbbbbbbbbbbb",
      );
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-token");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      return new Response("start,end,label\n00:00:00.000,00:00:01.000,cut\n", {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": 'attachment; filename="cutlist.csv"',
        },
      });
    });
    const api = createApiClient(configuration, fetch);
    const result = await runEffect(
      readInterchangeAttachment(api, "p_aaaaaaaaaaaa", "i_bbbbbbbbbbbbbbbbbbbbbbbb", "csv"),
    );
    expect(result.filename).toBe("cutlist.csv");
    expect(result.blob.type).toBe("text/csv; charset=utf-8");
    expect(await result.blob.text()).toContain("cut");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("preserves safe server failures and correlation IDs", async () => {
    const api = {
      mediaRequest: async () =>
        Response.json(
          { error: { code: "revision_conflict", message: "Project changed.", requestId: "req-9" } },
          { status: 409, headers: { "X-Request-ID": "req-9" } },
        ),
    };
    await expect(
      runEffect(
        readInterchangeAttachment(api, "p_aaaaaaaaaaaa", "i_bbbbbbbbbbbbbbbbbbbbbbbb", "chapters"),
      ),
    ).rejects.toMatchObject({
      name: "ApiFailure",
      status: 409,
      code: "revision_conflict",
      requestId: "req-9",
      message: "Project changed.",
    });
  });

  it("cancels an active native response read and releases its reader", async () => {
    let canceled = false;
    let startBlockedRead!: () => void;
    let releasePull!: () => void;
    const blockedReadStarted = new Promise<void>((resolve) => {
      startBlockedRead = resolve;
    });
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          startBlockedRead();
          return new Promise<void>((resolve) => {
            releasePull = resolve;
          });
        },
        cancel() {
          canceled = true;
          releasePull?.();
        },
      },
      { highWaterMark: 0 },
    );
    const api = { mediaRequest: async () => new Response(body) };
    const abort = new AbortController();
    const reading = Effect.runPromiseExit(
      readInterchangeAttachment(api, "p_aaaaaaaaaaaa", "i_bbbbbbbbbbbbbbbbbbbbbbbb", "csv"),
      { signal: abort.signal },
    );
    try {
      await blockedReadStarted;
      expect(body.locked).toBe(true);
      abort.abort();
      const exit = await reading;
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(canceled).toBe(true);
      expect(body.locked).toBe(false);
    } finally {
      abort.abort();
      releasePull?.();
      await reading.catch(() => undefined);
    }
  });

  it("bounds native attachment buffering", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_INTERCHANGE_ATTACHMENT_BYTES + 1));
      },
    });
    const cancel = vi.spyOn(body, "cancel");
    const api = { mediaRequest: async () => new Response(body) };
    await expect(
      runEffect(
        readInterchangeAttachment(api, "p_aaaaaaaaaaaa", "i_bbbbbbbbbbbbbbbbbbbbbbbb", "csv"),
      ),
    ).rejects.toThrow("download limit");
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe("bounded attachment resources", () => {
  const read = (response: Response) =>
    runEffect(
      readInterchangeAttachment({ mediaRequest: async () => response }, "project", "item", "csv"),
    );
  it("accepts exactly the cap and unlocks the successful reader", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new Uint8Array(MAX_INTERCHANGE_ATTACHMENT_BYTES));
        c.close();
      },
    });
    const cancel = vi.spyOn(body, "cancel");
    expect((await read(new Response(body))).blob.size).toBe(MAX_INTERCHANGE_ATTACHMENT_BYTES);
    expect(body.locked).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });
  it("interrupts pending headers and cancels a transport body that arrives late", async () => {
    const started = deferred();
    let resolve!: (response: Response) => void;
    let signal!: AbortSignal;
    const api = {
      mediaRequest: (_path: string, init?: RequestInit) => {
        signal = init!.signal!;
        started.resolve();
        return new Promise<Response>((r) => {
          resolve = r;
        });
      },
    };
    const abort = new AbortController();
    const result = Effect.runPromiseExit(readInterchangeAttachment(api, "project", "item", "csv"), {
      signal: abort.signal,
    });
    await started.promise;
    abort.abort();
    const exit = await result;
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(signal.aborted).toBe(true);
    const cancelled = deferred();
    const body = new ReadableStream<Uint8Array>({ cancel: () => cancelled.resolve() });
    resolve(new Response(body));
    await cancelled.promise;
    expect(body.locked).toBe(false);
  });
  it("rejects a missing successful body and safely decodes missing/malformed error bodies", async () => {
    await expect(read(new Response(null))).rejects.toThrow("missing");
    for (const body of [null, "private proxy diagnostics"]) {
      await expect(
        read(new Response(body, { status: 500, headers: { "X-Request-ID": "req" } })),
      ).rejects.toMatchObject({
        status: 500,
        code: "http_error",
        requestId: "req",
        message: "Request could not be completed.",
      });
    }
  });
  it.each([
    ['attachment; filename="../secret.csv"', "cutlist.csv"],
    ['attachment; filename=".."', "cutlist.csv"],
    ['attachment; filename="."', "cutlist.csv"],
    ['attachment; filename=""', "cutlist.csv"],
    ['attachment; filename="unterminated', "cutlist.csv"],
    ['attachment; filename="safe.csv"garbage', "cutlist.csv"],
    ["attachment; filename*=UTF-8''bad%ZZ", "cutlist.csv"],
    ["attachment; filename*=UTF-8''bad%00.csv", "cutlist.csv"],
    ["attachment; filename*=UTF-8''bad%5Cpath.csv", "cutlist.csv"],
    ["attachment; filename*=UTF-8''%F0%9F%8E%AC%20%C3%A9.csv", "🎬 é.csv"],
    ['attachment; filename="review.csv"', "review.csv"],
    ["", "cutlist.csv"],
  ])("sanitizes filename %s", async (disposition, filename) => {
    expect(
      (await read(new Response("text", { headers: { "Content-Disposition": disposition } })))
        .filename,
    ).toBe(filename);
  });
  it("releases an errored native reader without replacing its error", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("Read failed"));
      },
    });
    const cancel = vi.spyOn(body, "cancel");
    await expect(read(new Response(body))).rejects.toThrow("Read failed");
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("native attachment download handoff", () => {
  it.each(["success", "click failure", "interruption"])(
    "revokes after handoff on %s",
    async (mode) => {
      vi.useFakeTimers();
      const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:attachment");
      const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
      const abort = new AbortController();
      const anchor = {
        href: "",
        download: "",
        click: vi.fn(() => {
          expect(revoke).not.toHaveBeenCalled();
          if (mode === "click failure") throw new Error("Click failed");
          if (mode === "interruption") abort.abort();
        }),
      };
      vi.stubGlobal("document", { createElement: () => anchor });
      const result = Effect.runPromiseExit(
        downloadInterchangeAttachment({ blob: new Blob(["text"]), filename: "cuts.csv" }),
        { signal: abort.signal },
      );
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(create).toHaveBeenCalledOnce();
      expect(anchor.click).toHaveBeenCalledOnce();
      expect(anchor.download).toBe("cuts.csv");
      expect(revoke).not.toHaveBeenCalled();
      await vi.runAllTimersAsync();
      const exit = await result;
      expect(Exit.isSuccess(exit)).toBe(mode === "success");
      expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:attachment");
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
