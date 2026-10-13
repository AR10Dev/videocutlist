# Markdown → Beads migration

Cutover: 2026-10-13, Beads 1.3.1, workspace prefix `vcl`.
This is an immutable migration receipt, not a second live task board.
Fetch current state and full discussion with `bd show <id> --json`.

## Preserved records

Imported 25 tickets: 15 implemented completions, 2 measured no-change outcomes,
6 declined tickets, and 2 unfinished tickets. Descriptions, acceptance checkboxes,
full discussion, source identifiers and SHA-256 hashes were preserved. Native
status is separate from triage labels. All original tickets declared no mandatory
blockers, so no dependency edges were invented. Import timestamps are migration
time, not inferred original authorship dates; original dated notes remain intact.
Priority defaults to 2 because the original format had no canonical priority field.

Legacy `wontfix` meant both completed and declined. Successful tickets now close
with outcome:completed or outcome:verified-no-change; only declined tickets carry
wontfix and outcome:declined. Legacy statuses remain in migration metadata.

| Legacy ticket | Beads ID | Native status at cutover | Outcome at cutover |
| --- | --- | --- | --- |
| 01 | `vcl-52cb344b` | closed | completed |
| 02 | `vcl-b544c657` | blocked | unfinished; legacy needs-info |
| 03 | `vcl-4c8bcecb` | closed | completed |
| 04 | `vcl-08a3bc87` | closed | verified-no-change |
| 05 | `vcl-576c3174` | closed | completed |
| 06 | `vcl-8cef4736` | closed | completed |
| 07 | `vcl-9524ba7d` | closed | completed |
| 08 | `vcl-7509f78e` | closed | completed |
| 09 | `vcl-adab340c` | closed | completed |
| 10 | `vcl-2b2d476b` | closed | verified-no-change |
| 11 | `vcl-cdb3594f` | closed | completed |
| 12 | `vcl-a0216c32` | closed | completed |
| 13 | `vcl-5964d304` | blocked | unfinished; legacy needs-info |
| 14 | `vcl-9d2ce3da` | closed | declined |
| 15 | `vcl-dbf8b563` | closed | completed |
| 16 | `vcl-2f693c74` | closed | completed |
| 17 | `vcl-cd722d21` | closed | completed |
| 18 | `vcl-9930aa01` | closed | completed |
| 19 | `vcl-19affe19` | closed | declined |
| 20 | `vcl-975a3543` | closed | declined |
| 21 | `vcl-c9be6f94` | closed | declined |
| 22 | `vcl-5987d620` | closed | completed |
| 23 | `vcl-cdb50bcb` | closed | declined |
| 24 | `vcl-a75bba8f` | closed | completed |
| 25 | `vcl-4726d309` | closed | declined |

## Unfinished handoffs

- Legacy 02: `vcl-b544c657`. The five-second policy has already been approved;
  implementation at c708c921f3c8cfa242e7d2bd53eec4a136dad0af awaits independent
  review and integration. Imported legacy needs-info is retained conservatively;
  re-triage from the latest comment instead of re-asking the resolved policy question.
- Legacy 13: `vcl-5964d304`. Pins/update policy are partial completion;
  capability-drop/no-new-privileges changes remain unvalidated. Preserve the
  runtime worktree until a supported container host/remedy passes the harness.

Recorded completion evidence refers to the audit integration branch, not this
checkout's older source HEAD. Migration changed no application source and closed
no additional work. Existing dirty worktrees and owner locks were preserved.

## Recovery and publication

Original Markdown/instructions and a full native Dolt backup were saved privately
under `$PI_CODING_AGENT_DIR/backups/beads/videocutlist/20261013-170205/`.
The saved JSONL and mapping under `.scratch/pi-beads-billion-context/` are one-time
migration artifacts, not synchronization inputs. Do not regenerate/re-import them
against live task updates.

Git hooks were not installed. No new source commit remains, and no merge or remote
push was performed. Beads remote-add unexpectedly auto-committed config.yaml;
that single unpublished generated-file commit was verified and undone with a
soft reset, preserving the file, original source HEAD, index state and user edits.
Portable .beads policy/config/metadata and this specification are ready for review.
The configured data remote matches GitHub origin; its initial `bd dolt push` is
still pending explicit approval. Source pushes and task-data pushes are distinct;
new clones need `bd bootstrap` once the task-data remote is published. Local backup
has been verified separately; remote publication/recovery remains untested.

The retained `.scratch/claude-audit/` ticket files and saved queues are historical.
Use Beads for every new status update, dependency, claim or completion handoff.
