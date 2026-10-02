import type * as EffectApiTypes from "../../generated/effect-api";
import * as Schema from "effect/Schema";
import { validateSegmentLabel } from "../preview/model";

export type RecentProject = { id: string; label: string; lastOpened: number };

export const recentProjectsKey = "videocutlist.recent-projects.v1";
const projectId = /^p_[A-Za-z0-9_-]{12,64}$/;
const recentProjectSchema = Schema.Struct({
  id: Schema.String.check(
    Schema.makeFilter((id) => (projectId.test(id) ? undefined : "Invalid project ID")),
  ),
  label: Schema.String.check(
    Schema.makeFilter((label) =>
      label.trim() && label.length <= 120 ? undefined : "Invalid recent project label",
    ),
  ),
  lastOpened: Schema.Number.check(Schema.isInt())
    .check(Schema.isGreaterThanOrEqualTo(0))
    .check(Schema.isLessThanOrEqualTo(8_640_000_000_000_000)),
});

export const newProjectId = () => `p_${crypto.randomUUID()}`;

export const validProjectId = (value: unknown): value is string =>
  typeof value === "string" && projectId.test(value);

export const recentProjects = (value: unknown): RecentProject[] => {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value
    .flatMap((entry) => {
      let parsed: Schema.Schema.Type<typeof recentProjectSchema>;
      try {
        parsed = Schema.decodeUnknownSync(recentProjectSchema)(entry);
      } catch {
        return [];
      }
      if (ids.has(parsed.id)) return [];
      ids.add(parsed.id);
      return [parsed];
    })
    .slice(0, 20);
};

export const confirmDiscard = (dirty: boolean, confirm: () => boolean) => !dirty || confirm();

export const projectJson = (project: unknown): string => {
  if (!project || typeof project !== "object") throw new Error("Project is too large or invalid.");
  const text = JSON.stringify(project);
  if (new TextEncoder().encode(text).byteLength > 1 << 20)
    throw new Error("Project is too large or invalid.");
  return text;
};

const jsonObject = Schema.Record(Schema.String, Schema.Unknown);
const projectRecord = jsonObject;
const loose = <A extends Schema.Struct.Fields>(fields: A) =>
  Schema.StructWithRest(Schema.Struct(fields), [jsonObject]);
const projectHeader = loose({
  schemaVersion: Schema.Literal(2),
  name: Schema.String.check(
    Schema.makeFilter((name) => (name.trim() ? undefined : "Project name is required")),
  ),
  items: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1)),
});
const projectItemHeader = loose({
  id: Schema.String.check(Schema.isPattern(/^i_[A-Za-z0-9_-]{12,64}$/)),
  mediaId: Schema.String.check(Schema.isPattern(/^m_[A-Za-z0-9_-]{43}$/)),
  segments: Schema.Array(Schema.Unknown),
  exportOptions: projectRecord,
});
const interchangeSegments = Schema.Array(
  loose({
    startMs: Schema.Number.check(Schema.isInt()),
    endMs: Schema.Number.check(Schema.isInt()),
    label: Schema.optionalKey(
      Schema.String.check(
        Schema.makeFilter((label) =>
          validateSegmentLabel(label) === undefined ? undefined : "Invalid segment label",
        ),
      ),
    ),
  }),
);
const interchangeExportOptions = loose({
  mode: Schema.optionalKey(Schema.Literals(["merge", "separate"])),
  selection: Schema.optionalKey(Schema.Literals(["segments", "gaps"])),
  cutStrategy: Schema.optionalKey(
    Schema.Literals(["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"]),
  ),
  container: Schema.optionalKey(Schema.Literals(["mkv", "mp4", "mov"])),
  destinationId: Schema.optionalKey(Schema.String),
  filenameTemplate: Schema.optionalKey(Schema.String),
  streamIndexes: Schema.optionalKey(
    Schema.Array(Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0))),
  ),
});
const interchangeEditorState = Schema.Struct({
  playheadMs: Schema.Number.check(Schema.isFinite()),
  zoom: Schema.Number.check(Schema.isGreaterThanOrEqualTo(1)),
  muted: Schema.Boolean,
});
const legacyProject = loose({
  mediaId: Schema.String,
  segments: Schema.Array(Schema.Unknown),
  uiState: Schema.Unknown.check(
    Schema.makeFilter((value) =>
      value && typeof value === "object" ? undefined : "Invalid legacy editor state",
    ),
  ),
});

export type ProjectRecovery = {
  version: 1;
  projectId: string;
  revision: number;
  schemaVersion: 2;
  name: string;
  items: EffectApiTypes.Project["items"][number][];
  savedAt: number;
};
const projectRecoverySchema = loose({
  version: Schema.Literal(1),
  projectId: Schema.String.check(
    Schema.makeFilter((id) => (projectId.test(id) ? undefined : "Invalid project ID")),
  ),
  revision: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
  schemaVersion: Schema.Literal(2),
  name: Schema.String.check(
    Schema.makeFilter((name) => (name.trim() ? undefined : "Project name is required")),
  ),
  items: Schema.Array(Schema.Unknown).check(Schema.isMinLength(1)),
  savedAt: Schema.Number.check(Schema.isInt()).check(Schema.isGreaterThanOrEqualTo(0)),
});

export const parseProjectRecovery = (value: unknown): ProjectRecovery | undefined => {
  if (!Schema.is(projectRecoverySchema)(value)) return;
  try {
    parseProjectJson(JSON.stringify(value));
    return value as ProjectRecovery;
  } catch {
    return;
  }
};

export const parseProjectJson = (text: string): Record<string, unknown> => {
  if (new TextEncoder().encode(text).byteLength > 1 << 20)
    throw new Error("Project file is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Project file is invalid JSON.");
  }
  if (!Schema.is(projectRecord)(value)) throw new Error("Project shape is invalid.");
  if (value.schemaVersion === 2) {
    if (!Schema.is(projectHeader)(value)) throw new Error("Project shape is invalid.");
    const ids = new Set<string>();
    for (const item of value.items) {
      if (!Schema.is(projectItemHeader)(item) || ids.has(item.id))
        throw new Error("Project item is invalid.");
      ids.add(item.id);
      if (!Schema.is(interchangeSegments)(item.segments))
        throw new Error("Project segments are invalid.");
      if (!Schema.is(interchangeExportOptions)(item.exportOptions))
        throw new Error("Project export options are invalid.");
      if (item.editorState && !Schema.is(interchangeEditorState)(item.editorState))
        throw new Error("Project editor state is invalid.");
    }
  } else if (!Schema.is(legacyProject)(value)) {
    throw new Error("Project shape is invalid.");
  }
  return value;
};
