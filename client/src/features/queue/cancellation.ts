export function abortAndClear(controller?: AbortController): undefined {
  controller?.abort();
  return undefined;
}

export function abortCancellationControllers(
  exportController?: AbortController,
  detectionController?: AbortController,
): [undefined, undefined] {
  return [abortAndClear(exportController), abortAndClear(detectionController)];
}

export const cancellationIsCurrent = (controller: AbortController, current?: AbortController) =>
  current === controller && !controller.signal.aborted;
