# User documentation

Guides for installing, using, and maintaining VideoCutlist.

## Getting started

- [Container deployment](runbooks/containers.md)
- [Operations](runbooks/operations.md)
- [Connectivity examples](../deployments/connectivity-examples/README.md)

## Developing

- [Contributor setup and checks](../CONTRIBUTING.md)

## Editing and exporting

1. Configure a media root using the deployment guide, then use **Rescan library**
   in Settings to discover its files.
2. Browse media and add the files you want to edit to a project.
3. Set In and Out marks to create a non-overlapping segment. Rename it and choose
   whether to include it in the export. **New segment** or Escape starts a new draft.
4. Open Export, choose the output container, cut strategy, and destination, then
   use **Create clips**. Pending project changes are saved before export.

Missing previews, thumbnails, or waveforms do not prevent editing, saving, or
exporting. CSV and chapter files preserve timing and labels, but not segment
identity or inclusion; use project JSON when those details must be retained.

Stream-copy cuts are fast but not frame-exact away from keyframes. Precise
re-encoding and hybrid smart cuts are experimental; hybrid cuts require compatible
H.264 constant-frame-rate MKV sources and MKV output. Native exports require Linux
or macOS; other platforms reject export before encoding begins.


## Integrations and project files

- [HTTP API](contracts/api.openapi.yaml)
- [Project JSON format](contracts/project-schema.json)
- [MCP client access](../README.md#mcp-clients)

MCP export proposals allow up to 20 project items and 100 ranges per item. Each
selected clip may be at most 10 minutes, with at most 30 minutes selected in total.

## Recovery

- [Preview cache recovery](runbooks/cache-recovery.md)
- [Export recovery](runbooks/export-recovery.md)
