import { Effect, Queue, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
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
  const pending: SnapshotFrame[] = [];
  const parser = Sse.makeParser(
    (parsed) => {
      if (parsed._tag === "Event") {
        pending.push({ event: parsed.event, id: parsed.id, data: parsed.data });
      }
    },
    { maxEventSize: Infinity },
  );
  const feed = function* (text: string): Generator<SnapshotFrame> {
    const error = parser.feed(text);
    if (error) throw error;
    yield* pending.splice(0);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* feed(decoder.decode(value, { stream: true }));
    }
    yield* feed(decoder.decode());
    // Preserve the former reader's dispatch of a final unterminated event.
    yield* feed("\n\n");
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

  return Stream.callback<A, Error>(
    (queue) => {
      const controller = new AbortController();
      const iterator = snapshots(controller.signal);
      const close = Effect.sync(() => controller.abort()).pipe(
        Effect.andThen(
          Effect.tryPromise({
            try: () => iterator.return(undefined),
            catch: () => undefined,
          }).pipe(Effect.ignore),
        ),
      );
      const consume = Effect.gen(function* () {
        while (true) {
          const next = yield* Effect.tryPromise({
            try: (signal) => {
              const interrupt = () => controller.abort();
              signal.addEventListener("abort", interrupt, { once: true });
              return iterator.next().finally(() => signal.removeEventListener("abort", interrupt));
            },
            catch: (cause) =>
              cause instanceof Error ? cause : new Error("Job observation failed."),
          });
          if (next.done) return;
          if (!(yield* Queue.offer(queue, next.value))) return;
        }
      });
      return Effect.ensuring(
        consume.pipe(
          Effect.matchEffect({
            onFailure: (error) => Queue.fail(queue, error),
            onSuccess: () => Queue.end(queue),
          }),
        ),
        close,
      );
    },
    { bufferSize: 1, strategy: "suspend" },
  );
}
