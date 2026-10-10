import { isTerminalState } from "./jobState";
import { Duration, Effect, Result, Schedule, Stream } from "effect";
import * as Sse from "effect/encoding/Sse";
import * as Schema from "effect/Schema";
import type { ApiClient } from "../../api";
import { ApiFailure, readApiError } from "../../api";

interface SnapshotFrame {
  readonly event: string;
  readonly id?: string;
  readonly data: string;
}

class RetryableSnapshotError extends Error {}

/** Decode SSE frames across arbitrary UTF-8 chunk and line boundaries. */
function readFrames(body: ReadableStream<Uint8Array>): Stream.Stream<SnapshotFrame, Error> {
  return Stream.suspend(() => {
    const decoder = new TextDecoder();
    const pending: SnapshotFrame[] = [];
    const parser = Sse.makeParser(
      (parsed) => {
        if (parsed._tag === "Event") pending.push(parsed);
      },
      { maxEventSize: Infinity },
    );
    return Stream.fromReadableStream({
      evaluate: () => body,
      onError: (cause) => new RetryableSnapshotError("Snapshot connection failed.", { cause }),
      // Release before the response scope cancels the source, including a pending read.
      releaseLockOnEnd: true,
    }).pipe(
      Stream.map((chunk) => decoder.decode(chunk, { stream: true })),
      // Flush UTF-8 and dispatch the final unterminated event only on normal EOF.
      Stream.concat(Stream.suspend(() => Stream.make(decoder.decode() + "\n\n"))),
      Stream.flatMap((text) => {
        const error = parser.feed(text);
        return error
          ? Stream.fail(new RetryableSnapshotError("Snapshot decoding failed.", { cause: error }))
          : Stream.fromArray(pending.splice(0));
      }),
    );
  });
}

/** Observe safe job/batch snapshots; closing this stream only releases its request and reader. */
export function observeSnapshots<A extends { readonly state: string }, I>(
  api: ApiClient,
  path: string,
  schema: Schema.Codec<A, I, never>,
  isTerminal: (snapshot: A) => boolean = (snapshot) => isTerminalState(snapshot.state),
): Stream.Stream<A, Error> {
  return Stream.suspend(() => {
    let cursor: string | undefined;
    let previousCursor: string | undefined;
    const decode = Schema.decodeUnknownSync(schema);
    const connection = Stream.unwrap(
      Effect.gen(function* () {
        const controller = yield* Effect.acquireRelease(
          Effect.sync(() => new AbortController()),
          (controller) => Effect.sync(() => controller.abort()),
        );
        const headers = new Headers({ Accept: "text/event-stream" });
        if (cursor !== undefined) headers.set("Last-Event-ID", cursor);
        const response = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: async (signal) => {
              const requestSignal = AbortSignal.any([signal, controller.signal]);
              const response = await api.request(path, { headers, signal: requestSignal });
              // A native/test transport can resolve after interruption; release its late body.
              if (requestSignal.aborted) {
                await response.body?.cancel().catch(() => undefined);
                throw new DOMException("Observation closed.", "AbortError");
              }
              return response;
            },
            catch: (cause) => new RetryableSnapshotError("Snapshot request failed.", { cause }),
          }),
          (response) => Effect.promise(async () => response.body?.cancel().catch(() => undefined)),
          { interruptible: true },
        );
        if (response.status === 429 || response.status >= 500)
          return yield* Effect.fail(new RetryableSnapshotError("Snapshot request is unavailable."));
        if (!response.ok) {
          const error = yield* Effect.promise(() => readApiError(response));
          return yield* Effect.fail(new ApiFailure(response.status, error));
        }
        if (!response.body)
          return yield* Effect.fail(new Error("The snapshot stream response had no body."));

        // Stream.retry resets on output: this marker resets even an empty successful connection.
        return Stream.make(undefined).pipe(
          Stream.concat(
            readFrames(response.body).pipe(
              Stream.rechunk(1),
              Stream.filterMap((frame) => {
                if (frame.id !== undefined) cursor = frame.id;
                if (frame.event !== "snapshot" && frame.event !== "resync") return Result.failVoid;
                let value: A;
                try {
                  value = decode(JSON.parse(frame.data));
                } catch {
                  return Result.failVoid;
                }
                if (frame.id !== undefined && frame.id === previousCursor) return Result.failVoid;
                previousCursor = frame.id;
                return Result.succeed(value);
              }),
            ),
          ),
        );
      }),
    ).pipe(Stream.concat(Stream.fail(new RetryableSnapshotError("Snapshot connection ended."))));

    return connection.pipe(
      Stream.retry(
        Schedule.exponential("250 millis").pipe(
          Schedule.modifyDelay(({ duration }) =>
            Effect.succeed(Duration.min(duration, Duration.seconds(10))),
          ),
          Schedule.while(({ input }) => input instanceof RetryableSnapshotError),
        ),
      ),
      Stream.filter((snapshot): snapshot is A => snapshot !== undefined),
      Stream.takeUntil(isTerminal),
      Stream.buffer({ capacity: 1, strategy: "suspend" }),
    );
  });
}
