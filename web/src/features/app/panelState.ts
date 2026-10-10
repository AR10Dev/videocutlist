export const workspaceTaskTabs = ["cuts", "detection", "export"] as const;
export type WorkspaceTask = (typeof workspaceTaskTabs)[number];

export type WorkspacePanelState = {
  activeTask: WorkspaceTask;
  mediaOpen: boolean;
  tasksOpen: boolean;
  settingsOpen: boolean;
  projectToolsOpen: boolean;
  shortcutHelpOpen: boolean;
};

export const defaultWorkspacePanelState: WorkspacePanelState = {
  activeTask: "cuts",
  mediaOpen: true,
  tasksOpen: true,
  settingsOpen: false,
  projectToolsOpen: false,
  shortcutHelpOpen: false,
};
