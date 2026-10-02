import { Effect, Queue, Stream } from "effect";
import * as Schema from "effect/Schema";
import type { ApiClient } from "../../api";
import { ApiFailure, readApiError } from "../../api";

interface SnapshotFrame {
  readonly event: string;
  readonly id?: string;
  readonly data: string;
}

/** Decode SSE frames across arbitrary UTF-8 chunk and line boundaries. */
async function* readFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SnapshotFrame> {
  const reader = body.getReader();
  const cancelReader = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancelReader, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let id: string | undefined;
  let data: string[] = [];

  const line = (value: string): SnapshotFrame | undefined => {
    if (value === "") {
      const frame = data.length ? { event, id, data: data.join("\n") } : undefined;
      event = "message";
      data = [];
      return frame;
    }
    if (value.startsWith(":")) return;
    const separator = value.indexOf(":");
    const field = separator < 0 ? value : value.slice(0, separator);
    const content = separator < 0 ? "" : value.slice(separator + 1).replace(/^ /, "");
    if (field === "event") event = content;
    else if (field === "id" && !content.includes("\0")) id = content;
    else if (field === "data") data.push(content);
    return;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const current = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        const frame = line(current);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode();
    if (buffer) line(buffer.replace(/\r$/, ""));
    const frame = line("");
    if (frame) yield frame;
  } finally {
    signal.removeEventListener("abort", cancelReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

const terminalStates = new Set(["succeeded", "failed", "cancelled"]);

/** Observe safe job/batch snapshots; closing this stream only releases its reader. */
export function observeSnapshots<A extends { readonly state: string }, I>(
  api: ApiClient,
  path: string,
  schema: Schema.Codec<A, I, never>,
  isTerminal: (snapshot: A) => boolean = (snapshot) => terminalStates.has(snapshot.state),
): Stream.Stream<A, Error> {
  const snapshots = async function* (signal: AbortSignal): AsyncGenerator<A> {
    let cursor: string | undefined;
    let previousCursor: string | undefined;
    let retryDelay = 250;

    while (!signal.aborted) {
      const headers = new Headers({ Accept: "text/event-stream" });
      if (cursor !== undefined) headers.set("Last-Event-ID", cursor);
      let response: Response;
      try {
        response = await api.request(path, { headers, signal });
      } catch {
        await delay(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, 10_000);
        continue;
      }
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        throw new ApiFailure(response.status, await readApiError(response));
      }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel().catch(() => undefined);
        await delay(retryDelay, signal);
        retryDelay = Math.min(retryDelay * 2, 10_000);
        continue;
      }
      if (!response.ok) throw new ApiFailure(response.status, await readApiError(response));
      if (!response.body) throw new Error("The snapshot stream response had no body.");
      retryDelay = 250;

      let terminal = false;
      try {
        for await (const frame of readFrames(response.body, signal)) {
          if (frame.id !== undefined) cursor = frame.id;
          if (frame.event !== "snapshot" && frame.event !== "resync") continue;
          let value: A;
          try {
            value = Schema.decodeUnknownSync(schema)(JSON.parse(frame.data));
          } catch {
            continue;
          }
          if (frame.id !== undefined && frame.id === previousCursor) continue;
          previousCursor = frame.id;
          terminal = isTerminal(value);
          yield value;
          if (terminal) break;
        }
      } catch {
        // A broken connection resumes from the latest cursor.
      }
      if (terminal) return;
      await delay(retryDelay, signal);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    }
  };

  return Stream.callback<A, Error>((queue) =>
    Effect.tryPromise({
      try: async (signal) => {
        for await (const snapshot of snapshots(signal)) {
          if (!Queue.offerUnsafe(queue, snapshot)) return;
        }
      },
      catch: (cause) => (cause instanceof Error ? cause : new Error("Job observation failed.")),
    }).pipe(
      Effect.matchEffect({
        onFailure: (error) => Queue.fail(queue, error),
        onSuccess: () => Queue.end(queue),
      }),
    ),
  );
}
