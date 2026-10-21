import type { JSX } from "solid-js";

type Variant = "info" | "success" | "warning" | "error";
const variants: Record<Variant, string> = {
  info: "alert-info",
  success: "alert-success",
  warning: "alert-warning",
  error: "alert-error",
};

export function Notice(props: {
  variant?: Variant;
  children: JSX.Element;
  busy?: boolean;
  label?: string;
}) {
  return (
    <div
      class={`alert alert-soft flex flex-wrap items-center gap-2 rounded-md px-2.5 py-2 text-sm text-base-content [&>span]:min-w-0 [&>span]:wrap-anywhere ${variants[props.variant ?? "info"]}`}
      role={props.variant === "error" || props.variant === "warning" ? "alert" : "status"}
      aria-busy={props.busy}
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}
