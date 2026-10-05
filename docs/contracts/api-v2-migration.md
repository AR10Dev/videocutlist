# API v2 migration

API v2 is a breaking replacement; there is no `/api/v1` compatibility facade.

- Send JSON control requests beneath `/api/v2` and media/file requests beneath
  `/media/v2`. Preserve the configured deployment base path and use opaque media
  IDs; filesystem paths are never API identifiers.
- Handle invalid input as `400` (not v1 `422`); conflicts are `409` and capacity
  rejection is `429`. Continue reading the safe `error` envelope and
  `X-Request-ID` correlation header.
- Add a fresh `Idempotency-Key` to each intentional durable job submission;
  browser clients use `crypto.randomUUID()`. Reuse the same key only to redeliver
  an uncertain submission with the same semantic payload. Reusing a key with a
  different payload returns `409 idempotency_conflict`. Include the reviewed
  `projectRevision` on export and detection submissions.
- Observe jobs and batches through their authenticated SSE snapshot routes.
  Reconnect with `Last-Event-ID`; a disconnect does not cancel server work.
- `/metrics`, `/health`, `/ready`, and MCP JSON-RPC `/mcp` remain separate
  deployment/protocol endpoints. Project document `schemaVersion` and local
  recovery formats are unchanged by the API protocol version.

For endpoint shapes, authentication, and response details, see the
[HTTP API contract](api.openapi.yaml). Upgrade separately hosted browser clients
and API integrations together with the server; older v1 clients cannot use v2
routes.
