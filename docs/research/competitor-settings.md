# Settings research

## Findings

- **LosslessCut** keeps application preferences in a config file and exposes a Settings UI. Its official CLI documentation lists settings overrides, an FFmpeg/FFprobe path setting, and `--config-dir` for relocating configuration. It also documents disabling `.llc` project sidecar files in app settings.
  - Sources: [CLI](https://github.com/mifi/lossless-cut/blob/master/docs/cli.md), [FAQ](https://github.com/mifi/lossless-cut/blob/master/docs/index.md)
- **Shotcut** separates application configuration from per-project/export choices. Its official configuration documentation lists an application-data directory containing configuration and settings such as proxy storage; export folders are selected during export.
  - Source: [Configuration Keys](https://www.shotcut.org/notes/configuration/)
- **Kdenlive** groups settings by scope: global Environment settings contain default project, temporary, and capture folders; project settings contain project folder, proxy, cache, and metadata tabs. It also supports cache limits and cached-data management.
  - Sources: [Environment](https://docs.kdenlive.org/en/getting_started/configure_kdenlive/configuration_environment.html), [Project settings](https://docs.kdenlive.org/en/project_and_asset_management/project_settings/general_settings.html)

## Implications for VideoCutlist

Use a single Settings destination in the application, but split it into clear scopes:

1. **Server / Library**: media roots and rescan.
2. **Exports**: destinations, filename template, retention.
3. **Performance**: preview limits, cache limit, concurrency.
4. **Editor**: cut strategy, mute default, timeline defaults.
5. **Security / Connection**: read-only status and deployment-managed warnings, not editable secrets in v1.

Keep container mounts, database/cache/export base paths, networking, authentication, and executable paths as deployment configuration. The app can manage directories only inside paths already visible to the server/container.
