# 02: Cuts inspector and application component migration

**What to build:** Compact Cuts inspector with accessible overflow operations, and documented daisyUI controls throughout remaining task/settings/queue views.
**Blocked by:** None
**Category:** enhancement
**Status:** complete

Read ../spec.md fully. Own CutsView.tsx plus ProjectsView.tsx, ExportView.tsx, DetectionView.tsx, QueueView.tsx and SettingsView.tsx. Do not edit App.tsx, style.css, LibraryView.tsx or controllers shared with ticket 01. Use existing mutations and semantic daisyUI classes; request coordination if a shared controller change is essential. Ticket 01 removes global legacy styling, so every ordinary control in your views needs its explicit component contract.

- [ ] Compact cut rows show order, label, times and duration; whole primary target selects.
- [ ] Secondary menu exposes all specified operations to pointer, keyboard and touch.
- [ ] Existing task/settings/queue behavior remains available with accessible daisyUI components.
- [ ] Focused relevant checks updated and run.

## Comments

Spec: `.scratch/editor-workspace-redesign/spec.md`. Starting commit: 33aeb0e965cc08d16ccff30a7bb9bee281f2aebf.

Completed in `29ee48ad759beb85c1188a5bded5e3ca143aac17`; merged as `2cbe894`. Evidence: client format check, lint, Vitest (19 files/94 tests), production build, and `git diff --check` passed.
