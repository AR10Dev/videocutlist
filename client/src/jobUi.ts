export function exportFailureMessage(code?: string): string {
  if (code === "interrupted_by_restart") return "Export was interrupted by a server restart. Try again.";
  if (code === "hybrid_smart_cut_unsupported_media")
    return "Hybrid Smart Cut requires H.264 constant-frame-rate video in MKV format. Use Stream Copy or Precise Re-encode instead.";
  return code ? `Export failed: ${code}.` : "Export failed.";
}
