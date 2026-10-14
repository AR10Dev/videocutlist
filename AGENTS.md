## Agent skills

### Issue tracker

Beads (`bd`) is the authoritative task tracker, stored in this repository's
`.beads/` Dolt workspace and managed through `bd`.
Before planning, fetching, publishing, implementing, triaging, or handing off
tracked work, read `.beads/WORKFLOW.md` and load the shared `beads` skill when
available.
Run `bd prime --no-memories` at session start and after compaction.

Development specifications live in `.beads/specs/<feature>/spec.md`; status,
blocking edges, claims, discussion, and completion evidence live in Beads.
The `.beads/` workspace is local and ignored by Git. Keep `docs/` exclusively
for client-facing Markdown; development notes belong in `.beads/development/`.

### Triage labels

Triage roles are Beads labels, separate from native lifecycle status.
See `.beads/WORKFLOW.md` for the mapping. `wontfix` means declined;
completed work closes with an explicit successful/no-change outcome.

### Domain docs

Domain documentation uses a single-context layout:

- Before exploring, read root `CONTEXT.md` (glossary and shared model) and relevant
  ADRs under `.beads/adr/` when present; proceed silently when absent.
- Create these documents lazily through domain modeling when terminology or
  decisions are resolved. Use glossary terms, avoid rejected synonyms, and
  reconsider or flag missing concepts for domain modeling.
- Explicitly identify output that contradicts an existing ADR.
