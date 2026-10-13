# Beads workspace

This repository uses Beads 1.3.1 with embedded Dolt, prefix `vcl`.

See [tracker policy](../docs/agents/issue-tracker.md) and
[audit migration](../docs/specs/claude-audit/migration.md).

```sh
bd prime --no-memories
bd ready --label ready-for-agent
bd list --status blocked
bd show <id> --json
```

Portable configuration, metadata, ignore rules and PRIME.md belong in Git.
The database, credentials, locks and local backups do not.

Git source publication and task-data publication are separate operations.
The data remote is configured, but the initial `bd dolt push` still needs approval.
Fresh clones use `bd bootstrap` after task data is published.

Original Markdown tickets are retained as historical evidence, not a live queue.
