import type * as EffectApiTypes from "../../generated/effect-api";

type Media = EffectApiTypes.Media;
export type DetectionReview = {
  jobId: string;
  projectId: string;
  mediaId: string;
  activeItemId: string | undefined;
  sourceFingerprint: string | undefined;
  baselineRevision: number;
  currentRevision: number;
  editorVersion: number;
  pendingLocalSave: boolean;
  invalidated: boolean;
};

export type DetectionReviewContext = {
  projectId: string;
  activeItemId: string | undefined;
  selected: Media | undefined;
  revision: number;
  editorVersion: number;
  saveConflict: boolean;
};

export type SubmittedDetection = {
  jobId: string;
  projectId: string;
  mediaId: string;
  activeItemId: string | undefined;
  sourceFingerprint: string | undefined;
  editorVersion: number;
};

export function synchronizeReview(
  review: DetectionReview,
  context: DetectionReviewContext,
): DetectionReview {
  if (review.invalidated) return review;
  const selected = context.selected;
  if (
    context.projectId !== review.projectId ||
    context.activeItemId !== review.activeItemId ||
    selected?.id !== review.mediaId ||
    selected?.etag !== review.sourceFingerprint ||
    context.saveConflict ||
    context.editorVersion !== review.editorVersion
  ) {
    return { ...review, invalidated: true, pendingLocalSave: false };
  }
  const revision = context.revision;
  if (revision === review.currentRevision) return review;
  if (review.pendingLocalSave && revision === review.currentRevision + 1) {
    return { ...review, currentRevision: revision, pendingLocalSave: false };
  }
  return { ...review, invalidated: true, pendingLocalSave: false };
}
export function newDetectionReview(
  job: EffectApiTypes.DetectionJob,
  context: DetectionReviewContext,
  submittedValue?: SubmittedDetection,
): DetectionReview {
  const selected = context.selected;
  const currentRevision = context.revision;
  const submitted = submittedValue?.jobId === job.id ? submittedValue : undefined;
  return {
    jobId: job.id,
    projectId: submitted?.projectId ?? context.projectId,
    mediaId: job.mediaId,
    activeItemId: submitted ? submitted.activeItemId : context.activeItemId,
    sourceFingerprint: submitted ? submitted.sourceFingerprint : selected?.etag,
    baselineRevision: job.projectRevision,
    currentRevision,
    editorVersion: submitted?.editorVersion ?? context.editorVersion,
    pendingLocalSave: false,
    invalidated:
      !selected ||
      selected.id !== job.mediaId ||
      currentRevision !== job.projectRevision ||
      context.saveConflict ||
      (submitted !== undefined &&
        (context.projectId !== submitted.projectId ||
          job.projectId !== submitted.projectId ||
          job.mediaId !== submitted.mediaId ||
          context.activeItemId !== submitted.activeItemId ||
          selected.etag !== submitted.sourceFingerprint ||
          context.editorVersion !== submitted.editorVersion)),
  };
}
