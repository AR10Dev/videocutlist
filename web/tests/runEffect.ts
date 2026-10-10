import { Cause, Effect, Exit } from "effect";

/** Promise consumers receive the original public failure, never a FiberFailure string. */
export async function runEffect<A, E>(
  effect: Effect.Effect<A, E>,
  signal?: AbortSignal,
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect, { signal });
  if (Exit.isSuccess(exit)) return exit.value;
  throw Cause.squash(exit.cause);
}
