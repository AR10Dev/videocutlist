import { z } from "zod";
import { validateSegmentLabel } from "../preview/model";

export type RecentProject = { id: string; label: string; lastOpened: number };

export const recentProjectsKey = "videocutlist.recent-projects.v1";
const projectId = /^p_[A-Za-z0-9_-]{12,64}$/;
const recentProjectSchema = z.object({
  id: z.string().regex(projectId),
  label: z.string().refine((label) => Boolean(label.trim()) && label.length <= 120),
  lastOpened: z.number().int().min(0).max(8_640_000_000_000_000),
});

export const newProjectId = () => `p_${crypto.randomUUID()}`;

export const validProjectId = (value: unknown): value is string =>
  typeof value === "string" && projectId.test(value);

export const recentProjects = (value: unknown): RecentProject[] => {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value
    .flatMap((entry) => {
      const parsed = recentProjectSchema.safeParse(entry);
      if (!parsed.success || ids.has(parsed.data.id)) return [];
      ids.add(parsed.data.id);
      return [parsed.data];
    })
    .slice(0, 20);
};

export const confirmDiscard = (dirty: boolean, confirm: () => boolean) => !dirty || confirm();

export const projectJson = (project: unknown): string => {
  if (!project || typeof project !== "object" || JSON.stringify(project).length > 1_000_000)
    throw new Error("Project is too large or invalid.");
  return JSON.stringify(project);
};

const projectRecord = z.record(z.string(), z.unknown());
const projectHeader = z.looseObject({
  schemaVersion: z.literal(2),
  name: z.string().refine((name) => Boolean(name.trim())),
  items: z.array(z.unknown()).min(1),
});
const projectItemHeader = z.looseObject({
  id: z.string().regex(/^i_[A-Za-z0-9_-]{12,64}$/),
  mediaId: z.string().regex(/^m_[A-Za-z0-9_-]{43}$/),
  segments: z.array(z.unknown()),
  exportOptions: projectRecord,
});
const interchangeSegments = z.array(
  z.looseObject({
    startMs: z.number().int(),
    endMs: z.number().int(),
    label: z
      .string()
      .refine((label) => validateSegmentLabel(label) === undefined)
      .optional(),
  }),
);
const interchangeExportOptions = z.looseObject({
  mode: z.enum(["merge", "separate"]).optional(),
  selection: z.enum(["segments", "gaps"]).optional(),
  cutStrategy: z.enum(["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"]).optional(),
  container: z.enum(["mkv", "mp4", "mov"]).optional(),
  destinationId: z.string().optional(),
  filenameTemplate: z.string().optional(),
  streamIndexes: z.array(z.number().int().min(0)).optional(),
});
const interchangeEditorState = z.object({
  playheadMs: z.number(),
  zoom: z.number().min(1),
  muted: z.boolean(),
});
const legacyProject = z.looseObject({
  mediaId: z.string(),
  segments: z.array(z.unknown()),
  uiState: z.unknown().refine((value) => Boolean(value) && typeof value === "object"),
});

export const parseProjectJson = (text: string): Record<string, unknown> => {
  if (text.length > 1_000_000) throw new Error("Project file is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Project file is invalid JSON.");
  }
  if (!projectRecord.validate(value)) throw new Error("Project shape is invalid.");
  if (value.schemaVersion === 2) {
    if (!projectHeader.validate(value)) throw new Error("Project shape is invalid.");
    const ids = new Set<string>();
    for (const item of value.items) {
      if (!projectItemHeader.validate(item) || ids.has(item.id))
        throw new Error("Project item is invalid.");
      ids.add(item.id);
      if (!interchangeSegments.validate(item.segments))
        throw new Error("Project segments are invalid.");
      if (!interchangeExportOptions.validate(item.exportOptions))
        throw new Error("Project export options are invalid.");
      if (item.editorState && !interchangeEditorState.validate(item.editorState))
        throw new Error("Project editor state is invalid.");
    }
  } else if (!legacyProject.validate(value)) {
    throw new Error("Project shape is invalid.");
  }
  return value;
};
