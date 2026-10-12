import * as Atom from "effect/reactivity/Atom";
import type * as Registry from "effect/reactivity/AtomRegistry";

/** A runtime-owned native command atom with synchronous typed results. */
export function syncCommand<Input, Output>(
  registry: Registry.AtomRegistry,
  run: (input: Input) => Output,
  safeFailure: (cause: unknown) => Error,
): (input: Input) => Output {
  type Invocation = {
    input: Input;
    completed: boolean;
    result?: Output;
    failure?: Error;
  };
  const atom = Atom.keepAlive(
    Atom.fnSync<Output, Invocation>((invocation) => {
      try {
        const result = run(invocation.input);
        invocation.result = result;
        invocation.completed = true;
        return result;
      } catch (cause) {
        const failure = safeFailure(cause);
        invocation.failure = failure;
        invocation.completed = true;
        throw failure;
      }
    }),
  );
  return (input) => {
    const invocation: Invocation = { input, completed: false };
    try {
      registry.set(atom, invocation);
      if (!invocation.completed) registry.get(atom);
    } catch (cause) {
      throw invocation.failure ?? safeFailure(cause);
    }
    if (invocation.failure) throw invocation.failure;
    if (!invocation.completed) throw safeFailure(new Error("Command did not complete."));
    return invocation.result as Output;
  };
}
