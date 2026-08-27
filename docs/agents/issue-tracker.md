# Issue tracker: Local Markdown

Issues and specs live as Markdown files under `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- Specification: `.scratch/<feature-slug>/spec.md`
- Tickets: `.scratch/<feature-slug>/issues/<NN>-<slug>.md`
- Number tickets in dependency order, starting at `01`
- Record `Blocked by`, `Category`, and `Status` near the top
- Append discussion and completion evidence under `## Comments`

## Publish an issue

Create the appropriate file under `.scratch/<feature-slug>/`, creating directories as needed.

## Fetch an issue

Read the referenced file. The user will normally provide its path or issue number.

## Ticket shape

```markdown
# <NN>: <Title>

**What to build:** <durable behavioral outcome>

**Blocked by:** <ticket numbers or None>

**Category:** bug|enhancement
**Status:** <current status>

- [ ] Testable acceptance criterion
```

Describe behavior and stable contracts rather than file paths or line numbers.
