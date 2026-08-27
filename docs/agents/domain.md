# Domain Docs

This repository uses a single-context domain-documentation layout.

## Before exploring

- Read root `CONTEXT.md` when it exists.
- Read relevant ADRs under `docs/adr/`.
- If these files do not exist, proceed silently.
- Create them lazily through the domain-modeling workflow when terminology or decisions are resolved.

## Layout

- `CONTEXT.md`: domain glossary and shared model
- `docs/adr/`: architectural decision records

## Vocabulary

Use terms defined in `CONTEXT.md`. Avoid synonyms the glossary rejects. If a needed concept is absent, reconsider the terminology or note the gap for domain modeling.

## ADR conflicts

Explicitly identify output that contradicts an existing ADR rather than silently overriding it.
