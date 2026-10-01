# VideoCutList context

VideoCutList is a single-host media editing application. Go owns authorization, durable work and data integrity; the browser owns immediate editor interaction. The current deployment access gate does not create per-user application identities.

## Shared language

- **Project**: a revisioned document containing ordered project items and their editing/export configuration.
- **Project item**: one project's reference to a media source and its selected segments. A media source can appear in multiple items.
- **Revision**: the persisted version of a project or settings document, used to detect conflicting writes. An older save completing does not make newer local edits saved.
- **Job**: durable background work with queued, running, succeeded, failed or cancelled state. Observing a job is distinct from cancelling it.
- **Batch**: a group of export jobs whose status and progress derive from its child jobs.
- **Command submission**: one intentional request to start durable work. Retrying delivery of the same submission is distinct from intentionally submitting new work.
- **Workspace**: the browser's current authenticated connection and owned resources. Replacing it disposes old-session work and cached data; closing a panel need not end job observation.

Opaque IDs identify original media. Filesystem paths and authentication/MCP secrets are not public media identifiers and must not enter browser persistence, logs or generated contracts.

## Protocol work

The approved rewrite separates the JSON control API from native media/file transport while retaining the Go backend. Protocol version and project document schema version are independent. See [the protocol boundary decision](docs/adr/0001-json-control-native-media.md). Implementation specifications and dependency-ordered tickets live under `.scratch/`.
