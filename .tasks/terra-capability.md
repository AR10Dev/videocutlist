# Terra Capability

- Explicit Terra selection: yes.
- Configuration: subagents are spawned with `model: gpt-5.6-terra`; the
  capability probe reported runtime model `gpt-5.6-terra`.
- Isolated worktrees: yes. Existing worktrees are present, and a temporary
  detached worktree was created and removed successfully.
- Parallel subagents: yes; this controller has four total concurrency slots.
- Limitations: Git metadata writes require elevated sandbox permission. Go and
  gofmt are not currently on `PATH`. The controller prompt is an untracked
  user file and is excluded from refactor commits.

