export const isActiveState = (state: string | undefined): boolean =>
  state === "queued" || state === "running";

export const isTerminalState = (state: string | undefined): boolean =>
  state === "succeeded" || state === "failed" || state === "cancelled";
