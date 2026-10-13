# VideoCutlist Beads context

Beads is the authoritative task tracker. This migration supersedes the old
Markdown tracker instructions, including stale copies in linked worktrees.
Load the shared `beads` skill when available. Read `docs/agents/issue-tracker.md`
relative to the repository containing the resolved `.beads/` workspace.

- Fetch full tickets and comments: `bd show <id> --json`.
- Approved frontier: `bd ready --label ready-for-agent --json`.
- Claim with a unique session/worker actor; linked worktrees share the tracker.
- Store blockers as native dependency edges and specifications as tracked Markdown.
- Record validation/branch/commit evidence before closing. Partial or unreviewed work stays unfinished.
- Completed and verified-no-change outcomes are distinct from declined `wontfix`.
- Preserve existing dirty worktrees and ownership locks. Serialize embedded-Dolt writes.
- At handoff, update Beads, inspect Git changes and report remaining work.
- Git commits/merges/pushes and `bd dolt push` require explicit operator approval.
- Refresh this context after compaction with `bd prime --no-memories`.

For legacy audit references, resolve the ID using
`docs/specs/claude-audit/migration.md`, then fetch current Beads state and comments.
