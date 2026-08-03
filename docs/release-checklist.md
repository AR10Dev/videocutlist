# Release candidate checklist

## Architecture and packaging

- [ ] `make smoke` passes: Go format/vet/race/build, client lint/Vitest/build,
      architecture and deployment checks, and Playwright.
- [ ] `scripts/ops/check-architecture.sh` confirms the package and provider
      boundaries in [architecture](architecture.md).
- [ ] Installer stages `client/dist`, matching the server static path.
- [ ] Systemd remains the primary deployment; no primary script or runbook
      needs a connectivity-provider executable, service, variable, or command.

## Security and data safety

- [ ] Media IDs are opaque and never expose original filesystem paths.
- [ ] Media roots, cache, database, and export permissions match the
      [installation runbook](runbooks/install-arch-cachyos.md).
- [ ] LAN binds use a specific IP literal, firewall policy, and suitable
      application authentication.
- [ ] Cross-origin clients use exact `EDITAPP_ALLOWED_ORIGINS`; proxy identity
      is enabled only for configured trusted peer CIDRs.
- [ ] Preview and export publication remain validated and atomic.
- [ ] Release notes say stream-copy exports are not frame-exact away from
      keyframes.

## Deployment acceptance

- [ ] Install on a disposable Arch/CachyOS host and configure media roots.
- [ ] Start, restart, and verify with `scripts/ops/verify-deployment.sh`.
- [ ] Exercise backup, rollback, cache recovery, and export recovery.
- [ ] If needed, select one reviewed optional connectivity example; do not
      enable public exposure or expose the raw listener publicly.
