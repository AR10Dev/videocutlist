import { describe, expect, it } from "vitest";
import { createExportDownload } from "../src/features/export/download";

describe("export download actions", () => {
  it("allows only one active transfer and clears a failed transfer before retrying", async () => {
    let rejectTransfer!: (cause: unknown) => void;
    let finishTransfer!: () => void;
    let attempts = 0;
    const action = createExportDownload(
      () =>
        new Promise<void>((resolve, reject) => {
          attempts++;
          rejectTransfer = reject;
          finishTransfer = resolve;
        }),
    );
    const transfer = action.download();
    expect(action.pending()).toBe(true);
    await action.download();
    expect(attempts).toBe(1);
    rejectTransfer(new Error("Output expired."));
    await transfer;
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("Output expired.");

    const retry = action.download();
    expect(action.pending()).toBe(true);
    expect(action.error()).toBe("");
    expect(attempts).toBe(2);
    finishTransfer();
    await retry;
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("");
  });

  it("cancels the active transfer without leaving the next transfer cancelled", async () => {
    const signals: AbortSignal[] = [];
    const action = createExportDownload(
      (signal) =>
        new Promise<void>((_, reject) => {
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            {
              once: true,
            },
          );
        }),
    );
    const transfer = action.download();
    action.cancel();
    await transfer;
    expect(signals[0].aborted).toBe(true);
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("Download cancelled.");

    action.cancel();
    const retry = action.download();
    expect(signals[1].aborted).toBe(false);
    expect(action.pending()).toBe(true);
    expect(action.error()).toBe("");
    action.cancel();
    await retry;
    expect(signals[1].aborted).toBe(true);
    expect(action.pending()).toBe(false);
    expect(action.error()).toBe("Download cancelled.");
  });
});
