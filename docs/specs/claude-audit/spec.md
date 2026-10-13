# Historical audit specification

This is the preserved pre-migration specification, not a live queue. Status
summaries below are dated historical snapshots. Beads ticket comments contain
the latest decisions, acceptance criteria and completion evidence; fetch IDs
with `bd show <id> --json`. [Migration mapping](migration.md).

Ticket 02's latest imported note records approved policy and implementation
pending review/integration; it must not be treated as completed. Ticket 13's
runtime validation remains blocked. Original raw Markdown is privately backed up.

---

## Preserved Claude audit findings: triage specification

## Source and scope

Source: [AUDIT.md](AUDIT.md). Track all 25 distinct finding IDs in the findings register, including separate MNT-6 and MNT-7 tickets. Roadmap substeps remain within their parent finding rather than creating duplicate issues.

## Outcome

Each finding has a local issue with behavioral acceptance criteria, category, status, source attribution, and reproduction or decision requirements. All tickets initially use `needs-triage`: the audit is static evidence, not approval to implement every recommendation.

## Triage policy

- Confirm current repository evidence and deployment relevance before moving a ticket to `ready-for-agent`.
- Reliability claims requiring reproduction must be tested before selecting a fix.
- Preserve cancellation, shutdown, security, and atomicity. During current development, backward compatibility is not required: implement the current design directly, update affected callers/tests/contracts together, and do not add legacy implementations, compatibility shims, or database upgrade paths.
- Prefer the smallest demonstrated fix; architectural changes, new configuration, and tooling expansion require concrete justification.
- No ticket currently has a mandatory dependency: metrics and mechanical renames are not prerequisites for independent correctness work. Add blockers when an approved implementation actually requires another ticket.
- Retain completed or declined tickets as `wontfix`, with completion evidence or the decision recorded under Comments.

## Finding-to-ticket index

| Audit finding | Ticket |
| --- | --- |
| CI-1 | `vcl-52cb344b` (legacy 01) |
| REL-1 | `vcl-b544c657` (legacy 02) |
| REL-2 | `vcl-4c8bcecb` (legacy 03) |
| REL-3 | `vcl-08a3bc87` (legacy 04) |
| SEC-1 | `vcl-576c3174` (legacy 05) |
| SEC-2 | `vcl-8cef4736` (legacy 06) |
| SEC-3 | `vcl-9524ba7d` (legacy 07) |
| OPS-1 | `vcl-7509f78e` (legacy 08) |
| OPS-2 | `vcl-adab340c` (legacy 09) |
| OPS-3 | `vcl-2b2d476b` (legacy 10) |
| CI-2 | `vcl-cdb3594f` (legacy 11) |
| CI-3 | `vcl-a0216c32` (legacy 12) |
| CI-4 | `vcl-5964d304` (legacy 13) |
| SEC-4 | `vcl-9d2ce3da` (legacy 14) |
| SEC-5 | `vcl-dbf8b563` (legacy 15) |
| SEC-6 | `vcl-2f693c74` (legacy 16) |
| MNT-6 | `vcl-cd722d21` (legacy 17) |
| MNT-7 | `vcl-9930aa01` (legacy 18) |
| MNT-2 | `vcl-19affe19` (legacy 19) |
| MNT-1 | `vcl-975a3543` (legacy 20) |
| MNT-3 | `vcl-c9be6f94` (legacy 21) |
| MNT-4 | `vcl-5987d620` (legacy 22) |
| MNT-5 | `vcl-cdb50bcb` (legacy 23) |
| DOC-1 | `vcl-a75bba8f` (legacy 24) |
| DOC-2 | `vcl-4726d309` (legacy 25) |

## Implementation backlog

Declined tickets 14, 19, 20, 21, 23, and 25 were removed from the active issues directory and retained under archive/issues/ with their wontfix decisions. Implementation is on integration/claude-audit, based on 1c6866f. Worktree and seam ownership are recorded in implementation.md.

## Repository triage result

Historical evidence and dispositions are recorded in [triage.md](triage.md) and the imported ticket comments. After completing tickets 01, 03, 05, and 15 directly, there are 12 `ready-for-agent`, 3 `needs-triage`, no `needs-info`, and 10 `wontfix` tickets (4 completed, 6 declined). The completed changes are on integration/claude-audit at 00beb19; implementation.md and ticket Comments record validation. Only the ready frontier is approved for narrowly scoped agent work; unresolved policy choices and reproduction gates are not blanket implementation approval. No application changes were made during triage.

## Review corrections retained in tickets

Terminal finalization can fail during its initial state read, not only its write. Longer retry windows require lifecycle analysis. Artifact lock changes must preserve file identity and download lifetimes. Credential-write optimizations must preserve revocation races. Invariant clamping, package renames, file splits, and ticker changes are not automatically warranted. The maintainer approved MIT licensing and the policy defaults recorded in ticket Comments and triage.md. Legacy database retention/upgrades are declined; the codebase currently supports only its current design, with no backward-compatibility requirement.


## Finalization status (2026-10-13)

At integration HEAD `182a05d25772b1badedc49691da0d1ae9488267f`: 17 tickets are closed as retained `wontfix` (15 implemented plus measured no-change 04 and 10), 6 remain declined/archived `wontfix` (14, 19, 20, 21, 23, 25), and 2 remain unfinished `needs-info` (02, 13 runtime). Total: 25. Ticket 13 pins are partial only; runtime flags are dirty/unvalidated. Ticket 02 contention reproduces but its five-second persistence budget remains unapproved.
