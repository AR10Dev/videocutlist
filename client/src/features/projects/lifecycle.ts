export type RecentProject = { id: string; label: string; lastOpened: number };

export const recentProjectsKey = "videocutlist.recent-projects.v1";
const projectId = /^p_[A-Za-z0-9_-]{12,64}$/;

export const newProjectId = () => `p_${crypto.randomUUID()}`;

export const validProjectId = (value: unknown): value is string =>
  typeof value === "string" && projectId.test(value);

export const recentProjects = (value: unknown): RecentProject[] => {
  if (!Array.isArray(value)) return [];
  const ids = new Set<string>();
  return value
    .flatMap((entry) => {
      if (
        !entry ||
        typeof entry !== "object" ||
        !validProjectId((entry as RecentProject).id) ||
        typeof (entry as RecentProject).label !== "string" ||
        !(entry as RecentProject).label.trim() ||
        (entry as RecentProject).label.length > 120 ||
        !Number.isSafeInteger((entry as RecentProject).lastOpened) ||
        (entry as RecentProject).lastOpened < 0 ||
        (entry as RecentProject).lastOpened > 8_640_000_000_000_000 ||
        ids.has((entry as RecentProject).id)
      )
        return [];
      ids.add((entry as RecentProject).id);
      return [
        {
          id: (entry as RecentProject).id,
          label: (entry as RecentProject).label,
          lastOpened: (entry as RecentProject).lastOpened,
        },
      ];
    })
    .slice(0, 20);
};

export const confirmDiscard = (dirty: boolean, confirm: () => boolean) => !dirty || confirm();

export const projectJson = (project: unknown): string => {
  if (!project || typeof project !== "object" || JSON.stringify(project).length > 1_000_000)
    throw new Error("Project is too large or invalid.");
  return JSON.stringify(project);
};

export const parseProjectJson = (text: string): Record<string, unknown> => {
  if (text.length > 1_000_000) throw new Error("Project file is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Project file is invalid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Project shape is invalid.");
  const object = value as Record<string, unknown>;
  if (object.schemaVersion === 2) {
    if (
      typeof object.name !== "string" ||
      !object.name.trim() ||
      !Array.isArray(object.items) ||
      !object.items.length
    )
      throw new Error("Project shape is invalid.");
    const ids = new Set<string>();
    for (const item of object.items) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !/^i_[A-Za-z0-9_-]{12,64}$/.test(item.id) ||
        ids.has(item.id) ||
        typeof item.mediaId !== "string" ||
        !/^m_[A-Za-z0-9_-]{43}$/.test(item.mediaId) ||
        !Array.isArray(item.segments) ||
        !item.exportOptions ||
        typeof item.exportOptions !== "object" ||
        Array.isArray(item.exportOptions)
      )
        throw new Error("Project item is invalid.");
      ids.add(item.id);
      if (
        item.segments.some(
          (segment: unknown) =>
            !segment ||
            typeof segment !== "object" ||
            !("startMs" in segment) ||
            !("endMs" in segment) ||
            !Number.isSafeInteger(segment.startMs) ||
            !Number.isSafeInteger(segment.endMs) ||
            ("label" in segment && typeof segment.label !== "string"),
        )
      )
        throw new Error("Project segments are invalid.");
      const options = item.exportOptions;
      if (
        (options.mode !== undefined && !["merge", "separate"].includes(options.mode)) ||
        (options.selection !== undefined && !["segments", "gaps"].includes(options.selection)) ||
        (options.cutStrategy !== undefined &&
          !["stream_copy_preferred", "precise_reencode", "hybrid_smart_cut"].includes(
            options.cutStrategy,
          )) ||
        (options.container !== undefined && options.container !== "mkv") ||
        (options.destinationId !== undefined && typeof options.destinationId !== "string") ||
        (options.filenameTemplate !== undefined && typeof options.filenameTemplate !== "string") ||
        (options.streamIndexes !== undefined &&
          (!Array.isArray(options.streamIndexes) ||
            options.streamIndexes.some(
              (index: unknown) =>
                typeof index !== "number" || !Number.isSafeInteger(index) || index < 0,
            )))
      )
        throw new Error("Project export options are invalid.");
      if (
        item.editorState &&
        (!Number.isFinite(item.editorState.playheadMs) ||
          !Number.isFinite(item.editorState.zoom) ||
          item.editorState.zoom < 1 ||
          typeof item.editorState.muted !== "boolean")
      )
        throw new Error("Project editor state is invalid.");
    }
    return object;
  }
  if (
    typeof object.mediaId !== "string" ||
    !Array.isArray(object.segments) ||
    !object.uiState ||
    typeof object.uiState !== "object"
  )
    throw new Error("Project shape is invalid.");
  return object;
};
