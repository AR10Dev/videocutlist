export function saveIsCurrent(
  aborted: boolean,
  request: number,
  currentRequest: number,
  editorVersion: number,
  snapshotEditorVersion: number,
  projectID: string,
  currentProjectID: string,
  mediaID: string | undefined,
  currentMediaID: string | undefined,
) {
  return (
    !aborted &&
    request === currentRequest &&
    editorVersion === snapshotEditorVersion &&
    projectID === currentProjectID &&
    mediaID === currentMediaID
  );
}
