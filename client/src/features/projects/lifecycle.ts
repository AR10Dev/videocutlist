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
  if (
    typeof object.mediaId !== "string" ||
    !Array.isArray(object.segments) ||
    !object.uiState ||
    typeof object.uiState !== "object"
  )
    throw new Error("Project shape is invalid.");
  return object;
};
