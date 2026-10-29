import { Cause } from "effect";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { ApiFailure, apiErrorEnvelope } from "../../api";

export const requestErrorMessage = (failure: unknown, fallback: string): string => {
  if (failure instanceof Error) return failure.message;
  return apiErrorEnvelope(failure)?.message ?? fallback;
};

export const resourceErrorMessage = <A, E>(
  result: AsyncResult.AsyncResult<A, E>,
  fallback: string,
): string => {
  if (!AsyncResult.isFailure(result)) return "";
  const failure = Cause.squash(result.cause);
  return (
    apiErrorEnvelope(failure)?.message ??
    (failure instanceof ApiFailure ? failure.message : fallback)
  );
};
