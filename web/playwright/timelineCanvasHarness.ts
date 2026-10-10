import { createComponent } from "solid-js";
import { render } from "solid-js/web";
import { TimelineCanvas } from "../src/features/editor/TimelineCanvas";

/** Exercise native observer callbacks while thumbnail loads remain pending. */
export async function verifyCanvasImageCleanup() {
  const images: PendingImage[] = [];
  class PendingImage {
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    src = "";
    constructor() {
      images.push(this);
    }
  }
  const originalImage = window.Image;
  Object.defineProperty(window, "Image", { configurable: true, value: PendingImage });
  const container = document.createElement("div");
  container.style.cssText = "width:320px;height:80px";
  document.body.append(container);
  let dispose: (() => void) | undefined;
  const settleResize = () =>
    new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  try {
    dispose = render(
      () =>
        createComponent(TimelineCanvas, {
          thumbnailURL: "pending-thumbnail.png",
          waveform: [],
          durationMs: 10000,
        }),
      container,
    );
    await settleResize();
    const beforeResize = images.at(-1)!;
    container.style.width = "480px";
    await settleResize();
    const afterResize = images.at(-1)!;
    const resized = beforeResize !== afterResize;
    const releasedPrevious =
      beforeResize.onload === null && beforeResize.onerror === null && beforeResize.src === "";
    dispose();
    dispose = undefined;
    const releasedOnDispose = images.every(
      (image) => image.onload === null && image.onerror === null && image.src === "",
    );
    return { resized, releasedPrevious, releasedOnDispose };
  } finally {
    dispose?.();
    container.remove();
    Object.defineProperty(window, "Image", { configurable: true, value: originalImage });
  }
}
