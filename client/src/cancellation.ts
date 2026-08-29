export function abortAndClear(controller?: AbortController): undefined {
  controller?.abort();
  return undefined;
}

export const cancellationIsCurrent = (
  controller: AbortController,
  current?: AbortController,
) => current === controller && !controller.signal.aborted;
