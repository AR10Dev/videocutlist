import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "../src/api";
import {
  MAX_INTERCHANGE_ATTACHMENT_BYTES,
  readInterchangeAttachment,
  readInterchangeFile,
} from "../src/features/projects/interchange";

const configuration = {
  serverBaseUrl: "https://example.test/deploy",
  authentication: { type: "bearer" as const, token: "private-token" },
};

describe("project interchange attachments", () => {
  it("reads text files within the 1 MiB byte limit, independent of UTF-16 length", async () => {
    const text = "🎬".repeat(200_000);
    const file = new Blob([text]);
    expect(file.size).toBeLessThan(1 << 20);
    expect(file.size).toBeGreaterThan(text.length);
    await expect(readInterchangeFile(file, new AbortController().signal)).resolves.toBe(text);
    await expect(
      readInterchangeFile(new Blob(["🎬".repeat(262_145)]), new AbortController().signal),
    ).rejects.toThrow("1 MiB");
  });

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
    const result = await readInterchangeAttachment(
      api,
      "p_aaaaaaaaaaaa",
      "i_bbbbbbbbbbbbbbbbbbbbbbbb",
      "csv",
      new AbortController().signal,
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
      readInterchangeAttachment(
        api,
        "p_aaaaaaaaaaaa",
        "i_bbbbbbbbbbbbbbbbbbbbbbbb",
        "chapters",
        new AbortController().signal,
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
    const body = new ReadableStream<Uint8Array>({
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
    });
    const api = { mediaRequest: async () => new Response(body) };
    const abort = new AbortController();
    const reading = readInterchangeAttachment(
      api,
      "p_aaaaaaaaaaaa",
      "i_bbbbbbbbbbbbbbbbbbbbbbbb",
      "csv",
      abort.signal,
    );
    try {
      await blockedReadStarted;
      expect(body.locked).toBe(true);
      abort.abort();
      await expect(reading).rejects.toMatchObject({ name: "AbortError" });
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
    const api = { mediaRequest: async () => new Response(body) };
    await expect(
      readInterchangeAttachment(
        api,
        "p_aaaaaaaaaaaa",
        "i_bbbbbbbbbbbbbbbbbbbbbbbb",
        "csv",
        new AbortController().signal,
      ),
    ).rejects.toThrow("download limit");
  });
});
