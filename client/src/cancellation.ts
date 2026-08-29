export function abortAndClear(controller?: AbortController): undefined {
  controller?.abort();
  return undefined;
}
