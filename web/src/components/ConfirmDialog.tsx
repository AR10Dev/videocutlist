import { Dialog } from "@kobalte/core/dialog";
import { createContext, createSignal, onCleanup, useContext } from "solid-js";

type Confirmation = { title: string; message: string; action: string };
type Confirm = (decision: Confirmation) => Promise<boolean>;
const ConfirmationContext = createContext<Confirm>();

export const discardChanges: Confirmation = {
  title: "Discard unsaved changes?",
  message: "Changes since the last save will be lost.",
  action: "Discard changes",
};

export function createConfirmation() {
  const [decision, setRequest] = createSignal<Confirmation>();
  let resolve: ((accepted: boolean) => void) | undefined;
  let returnFocus: HTMLElement | undefined;
  const finish = (accepted: boolean) => {
    const complete = resolve;
    resolve = undefined;
    setRequest(undefined);
    complete?.(accepted);
  };
  onCleanup(() => finish(false));
  const confirm: Confirm = (next) => {
    // Never replace a pending decision with a different destructive action.
    if (resolve) return Promise.resolve(false);
    returnFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setRequest(next);
    return new Promise<boolean>((complete) => {
      resolve = complete;
    });
  };
  const View = () => (
    <Dialog open={Boolean(decision())} onOpenChange={(open) => !open && finish(false)}>
      <Dialog.Portal>
        <div class="modal modal-open">
          <Dialog.Overlay class="modal-backdrop" />
          <Dialog.Content
            class="modal-box"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (returnFocus?.isConnected) returnFocus.focus();
            }}
          >
            <Dialog.Title class="text-lg font-bold">{decision()?.title}</Dialog.Title>
            <Dialog.Description class="py-4">{decision()?.message}</Dialog.Description>
            <div class="modal-action">
              <button class="btn" type="button" onClick={() => finish(false)}>
                Cancel
              </button>
              <button class="btn btn-primary" type="button" onClick={() => finish(true)}>
                {decision()?.action}
              </button>
            </div>
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog>
  );
  return { confirm, View };
}

export const ConfirmationProvider = ConfirmationContext.Provider;

export function useConfirmation() {
  const confirm = useContext(ConfirmationContext);
  if (!confirm) throw new Error("ConfirmationProvider is missing.");
  return confirm;
}
