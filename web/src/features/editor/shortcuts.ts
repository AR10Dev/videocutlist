import { onCleanup } from "solid-js";
import type { createEditorController } from "./controller";

// DOM filtering and listener lifetime stay with the rendering owner.
export function installEditorShortcuts(
  editor: Pick<ReturnType<typeof createEditorController>, "dispatchShortcut">,
) {
  if (typeof window === "undefined") return;
  const handleKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (
      !(target instanceof Element) ||
      event.defaultPrevented ||
      document.querySelector(".settings-view")
    )
      return;
    const key = event.key.toLowerCase();
    const historyShortcut = (event.ctrlKey || event.metaKey) && ["z", "y"].includes(key);
    if (
      event.altKey ||
      ((event.ctrlKey || event.metaKey) && !historyShortcut) ||
      (event.shiftKey && !historyShortcut && !["/", "?"].includes(key)) ||
      target.closest(
        "textarea, select, [contenteditable]:not([contenteditable='false']), [role='combobox'], [role='menu'], [role='dialog'], dialog, .settings-view, [role='tablist'], input:not(.timeline-playhead-input)",
      ) ||
      (event.key === " " && target.closest("button, a, summary"))
    )
      return;
    if (editor.dispatchShortcut(event)) event.preventDefault();
  };
  window.addEventListener("keydown", handleKeyDown);
  onCleanup(() => window.removeEventListener("keydown", handleKeyDown));
}
