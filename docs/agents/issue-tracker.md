# Issue tracker: Beads

Beads (`bd`, currently 1.3.1) is the task source of truth for this repository. The workspace is `.beads/`, with prefix `vcl` and embedded Dolt storage. The shared Pi `beads` skill defines the cross-project workflow; this document is also sufficient for agents without that skill.

## Storage and scope

Tickets, lifecycle state, claims, dependencies, discussion and completion evidence are stored in this repository's `.beads/` workspace, using its managed local Dolt database. Manage them through `bd`; use `bd where` to resolve the workspace instead of editing database files. Each repository has its own tracker; only the Pi skill and `bd` executable are shared globally. Linked Git worktrees use their repository's shared tracker, not separate queues.

Specifications and supporting context are versioned Markdown under `docs/specs/<feature>/`. Original `.scratch/` tickets and saved workflows are historical evidence only. Database/credentials/runtime files stay ignored; task-data backup/publication is separate from Git source/config publication.

## Start and publish

Run `bd prime --no-memories` at session start and after compaction. Read tickets with `bd show <id> --json`, including comments. Discover approved work with `bd ready --label ready-for-agent --json`; unfiltered open tickets are not implementation approval. Use a unique session/worker actor when claiming: `bd update <id> --claim --actor <worker>`.

When a skill says publish/fetch/triage an issue, use native Beads records, not `.scratch/` ticket files. Shared specifications live at `docs/specs/<feature>/spec.md`, referenced with `--spec-id`. Create reviewed tickets with behavioral descriptions, native types, category/triage labels and testable acceptance criteria. Use `bd dep add <dependent> <prerequisite>` for blocking; `--parent` is hierarchy only. Add comments with `bd comments add <id> '<evidence/decision>'`.

## Triage and lifecycle

Native status and triage labels are distinct. Every active ticket has exactly one triage role:

| Label | Native status | Contract |
| --- | --- | --- |
| needs-triage | open | Awaiting evaluation; not implementation approval |
| needs-info | blocked | Missing information, access or a decision |
| ready-for-agent | open | Approved and specified; dependencies can still block |
| ready-for-human | blocked | Human-owned next step |
| wontfix | closed | Explicitly declined |

Category labels remain `bug` and `enhancement`; corresponding native types are `bug` and `feature`. Claiming changes native status to `in_progress`, retaining the approved triage label. On transitions, replace the former triage label and record the reason.

For completed work, remove the active triage label, add `outcome:completed` or `outcome:verified-no-change`, and close with validation and commit/PR evidence. Declined work uses `wontfix`, `outcome:declined`, and a reason. Partial or unreviewed work stays unfinished. Record the validated branch/commit: a ticket completed on the audit integration branch is not evidence that its fix exists in another checkout.

## Git, worktrees and recovery

- One code writer per worktree. Linked worktrees share this tracker; serialize task writes under embedded Dolt. Preserve existing locks and unfinished worktrees.
- Resolve workspace policy/specification paths from the repository containing `bd where`'s `.beads/`, even when the current linked worktree predates these documents.
- Commit portable `.beads/config.yaml`, `.beads/metadata.json`, `.beads/.gitignore`, `.beads/PRIME.md`, `.beads/README.md` and shared specs after review. Database, credentials, lock and backup files remain ignored.
- Git commits, merges, pushes and Beads remote synchronization need explicit operator authority. Hooks are intentionally not installed. Automatic Dolt push and backup Git push are disabled.
- The configured data remote uses the same GitHub repo, `git+https://github.com/AR10Dev/videocutlist.git`. `bd dolt push` publishes task data separately from source refs; it has NOT been run for this migration. A fresh clone needs `bd bootstrap` after task data is published.
- JSONL is an interchange/migration artifact, not the database or a full backup. Use `bd backup` for native backups; a private local migration backup exists outside this repository. Local backup success is not off-machine durability.
- At handoff, update task evidence/status, inspect Git changes, and report incomplete work and proposed publication commands.

## Migrated audit

All 25 legacy tickets, including declined/archive tickets, were imported with acceptance criteria and discussion. See [the mapping](../specs/claude-audit/migration.md) and [historical specification](../specs/claude-audit/spec.md). `.scratch/claude-audit/` is retained as frozen historical evidence. Its Markdown queues and saved workflow scripts must not be resumed as live tracking.

## Wayfinding operations

Create a map epic with `wayfinder:map`, child decision tickets with `wayfinder:<type>`, and native blockers. Query children with `bd list --parent <map> --json`; query claimable decisions with `bd ready --parent <map> --json`. Read the map, claim one decision, record its resolution as a comment, close it, and update the map's decision index. Keep the map open while work/fog remains. Refer to titles with IDs beside them, not fabricated issue URLs.
