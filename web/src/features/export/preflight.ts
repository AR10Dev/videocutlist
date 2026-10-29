import { useAtomValue } from "@effect/atom-solid";
import { Cause, Effect } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import * as Atom from "effect/reactivity/Atom";
import type * as EffectApiTypes from "../../generated/effect-api";
import { ApiFailure, apiErrorEnvelope } from "../../api";
import { readServerAtom, runServerMutation, type ServerState } from "../../app/server";

type ExportPreflight = EffectApiTypes.ExportPreflight;
const preflightFailureMessage = (failure: unknown): string => {
  if (failure instanceof ApiFailure)
    return `Export preflight failed (${failure.status}). Try again.`;
  const error = apiErrorEnvelope(failure);
  return error
    ? `Export preflight failed (${error.code}): ${error.message} (request ${error.requestId})`
    : "Export preflight could not be reached. Try again.";
};

export function createExportPreflight(server: ServerState, preflightKey: Atom.Atom<string>) {
  const { registry, runtime } = server;
  const generatedApi = server.generatedApi;
  const preflightMutation = generatedApi.mutation("default", "preflightExport");
  const preflightRequest = (request: { projectId: string; input: EffectApiTypes.ExportInput }) =>
    runServerMutation(registry, preflightMutation, {
      params: { projectId: request.projectId },
      payload: request.input,
    });

  type PreflightContext = {
    projectId: string;
    input: EffectApiTypes.ExportInput;
    dirty: boolean;
    valid: boolean;
  };
  const preflightIntent = Atom.keepAlive(
    Atom.make<{ mode: "automatic" } | { mode: "submission" | "checked"; key?: string }>({
      mode: "automatic",
    }),
  );
  const automaticPreflight = Atom.keepAlive(
    runtime.atom<ExportPreflight | undefined, unknown>((get) => {
      const key = get(preflightKey);
      const intent = get(preflightIntent);
      let context: PreflightContext;
      try {
        context = JSON.parse(key) as PreflightContext;
      } catch (cause) {
        return Effect.fail(new Error("Invalid export preflight context.", { cause }));
      }
      if (
        !context.valid ||
        context.dirty ||
        intent.mode === "submission" ||
        (intent.mode === "checked" && intent.key === key)
      )
        return Effect.succeed<ExportPreflight | undefined>(undefined);
      return Effect.andThen(Effect.sleep(250), preflightRequest(context));
    }),
  );
  const preflightCommand = Atom.keepAlive(
    runtime.fn(
      (
        request: { projectId: string; input: EffectApiTypes.ExportInput; key: string },
        get,
      ): ReturnType<typeof preflightRequest> => {
        if (get(preflightKey) !== request.key) return Effect.interrupt;
        // Function atoms read once; observe the key to interrupt, never replay, a mutation.
        get.subscribe(preflightKey, (key) => {
          if (key !== request.key) registry.set(preflightCommand, Atom.Interrupt);
        });
        return preflightRequest(request);
      },
    ),
  );
  const preflightResultAtom = Atom.make((get) => {
    const intent = get(preflightIntent);
    const result =
      intent.mode !== "automatic" && intent.key === get(preflightKey)
        ? get(preflightCommand)
        : get(automaticPreflight);
    // Native results retain previous successes during refresh; obsolete checks must not render.
    return result.waiting
      ? AsyncResult.initial<ExportPreflight | undefined, unknown>(true)
      : result;
  });
  const observedPreflight = useAtomValue(() => preflightResultAtom);
  const preflightResult = () => {
    observedPreflight();
    return registry.get(preflightResultAtom);
  };
  const preflight = () => {
    const result = preflightResult();
    return AsyncResult.isSuccess(result) ? result.value : undefined;
  };
  const preflightPending = () => preflightResult().waiting;
  const preflightError = () => {
    const result = preflightResult();
    return AsyncResult.isFailure(result) && !Cause.hasInterruptsOnly(result.cause)
      ? preflightFailureMessage(Cause.squash(result.cause))
      : "";
  };
  const suspendAutomaticPreflight = () => {
    registry.set(preflightIntent, { mode: "submission" });
    // Evaluate the dependency change now, releasing the old mutation before a fresh check.
    registry.get(automaticPreflight);
    registry.set(preflightCommand, Atom.Reset);
  };
  const freshPreflight = (request: { projectId: string; input: EffectApiTypes.ExportInput }) =>
    Effect.suspend(() => {
      const key = registry.get(preflightKey);
      registry.set(preflightIntent, { mode: "submission", key });
      registry.set(preflightCommand, { ...request, key });
      return readServerAtom(server, preflightCommand);
    });
  const cancelPreflight = () => {
    registry.set(preflightIntent, { mode: "checked", key: registry.get(preflightKey) });
    registry.get(automaticPreflight);
    registry.set(preflightCommand, Atom.Reset);
  };
  const retryPreflight = () => {
    if (registry.get(preflightIntent).mode === "submission") return;
    registry.set(preflightIntent, { mode: "automatic" });
    registry.refresh(automaticPreflight);
  };

  const finishPreflight = () => {
    const intent = registry.get(preflightIntent);
    if (intent.mode === "submission")
      registry.set(preflightIntent, { mode: "checked", key: intent.key });
  };
  return {
    preflightResult,
    finishPreflight,
    preflight,
    preflightPending,
    preflightError,
    suspendAutomaticPreflight,
    freshPreflight,
    cancelPreflight,
    retryPreflight,
  };
}
