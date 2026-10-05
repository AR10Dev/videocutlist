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

## Client generation and ownership

The client pins Effect, atom-solid, platform-browser and the OpenAPI generator to
stable `4.0.0`. Run `devenv shell -- pnpm --dir client run api:generate` after
changing `docs/contracts/api.openapi.yaml`, and check in the resulting
`client/src/generated/effect-api.ts`; do not edit it manually. The generator
selects JSON operations from the full authoritative contract. Native media/file
and SSE transport is deliberately not a second generated DTO pipeline.

`client/src/api.ts` owns shared URL/auth/error policy. The workspace owns one
registry and generated resource identity; feature controllers own local editor
interaction and command intent. Observing or disposing a resource does not cancel
a durable server job. A deliberate cancellation is a separate command. Browser
preferences and project recovery never contain tokens or MCP credentials.

## Browser persistence disposition (ticket 06)

Retain the existing synchronous, best-effort browser storage rather than replacing
it with `KeyValueStore`/`Atom.kvs` solely for API consistency. This satisfies the
conditional adoption requirement: no demonstrated preference-wiring reduction
preserves all existing behavior.

- Panel restoration parses each field independently, keeps valid siblings when a
  field is malformed, clamps widths to the viewport, and resets collapse state on
  initial display. Its Solid effect already owns the necessary layout state.
- Preview flags have existing raw `"true"`/`"false"` encodings and synchronous
  initial values; settings and recovery have field defaults and legacy JSON
  compatibility. Storage denial is nonfatal.
- In the installed Effect 4.0.0 implementation, `Atom.kvs` uses schema-store
  encoding, mounts read/write atoms in an atom runtime, and writes defaults for a
  missing key. Reproducing partial-field recovery, initial layout normalization,
  and exact legacy strings still needs custom codecs/error policy and the Solid
  state bridge. A raw `KeyValueStore` wrapper likewise adds Effect execution around
  the same get/set calls; it does not remove their domain policy.

Reconsider native persistence only when a real shared atom-owned preference needs
it and a compatibility test demonstrates unchanged keys, formats, synchronous
initialization, partial defaults and storage-denial behavior. Existing settings,
panel, preview and recovery tests remain the regression boundary. This disposition
does not change the protocol ADR or project/recovery schema versions.
