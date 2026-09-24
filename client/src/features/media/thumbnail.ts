type ObjectURLAPI = Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;

export async function createThumbnailObjectURL(
  response: Response,
  signal: AbortSignal,
  urlAPI: ObjectURLAPI = URL,
): Promise<string | undefined> {
  if (!response.ok || signal.aborted) return;
  const blob = await response.blob();
  if (signal.aborted) return;
  const url = urlAPI.createObjectURL(blob);
  if (signal.aborted) {
    urlAPI.revokeObjectURL(url);
    return;
  }
  return url;
}
