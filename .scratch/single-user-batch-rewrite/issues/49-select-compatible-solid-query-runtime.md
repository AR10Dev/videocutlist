# 49: Select a compatible Solid Query runtime

**What to build:** Establish a supported SolidJS, Vite compiler, and TanStack Solid Query version combination that installs reproducibly and produces a production bundle.

**Blocked by:** None

**Category:** enhancement
**Status:** completed

- [x] The selected SolidJS and `vite-plugin-solid` versions are mutually compatible.
- [x] The selected `@tanstack/solid-query` release resolves all Solid runtime imports during Vite production bundling.
- [x] The dependency manifest and lockfile install with `--frozen-lockfile`.
- [x] A minimal QueryClientProvider build smoke test passes without aliases or package-local patches.
- [x] The chosen versions and compatibility constraints are documented in the ticket comments.

## Comments

Ticket 11 found that `@tanstack/solid-query@5.102.8` declares a Solid 1 peer and imports `solid-js/store`, while the selected Solid 2 RC runtime no longer exports the required store module. Mounting the provider therefore fails production bundling. No production workaround is included here; resolve the supported dependency matrix first.

- Selected Solid 1.9.15, `vite-plugin-solid` 2.11.14, and `@tanstack/solid-query` 5.102.8.
- Replaced Solid 2-only runtime/plugin wiring, generated a frozen lockfile, and mounted `QueryClientProvider` in the application entrypoint.
- Validation: frozen install, production build, 63 Vitest tests, and Oxlint pass.
