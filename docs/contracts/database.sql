-- Contract only. Agents convert these definitions into numbered migrations.
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  root_alias TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (root_alias, relative_path)
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('export', 'detection', 'library_scan')),
  project_id TEXT,
  project_item_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'library_scan' AND project_id IS NULL AND project_item_id IS NULL)
    OR (kind != 'library_scan' AND project_id IS NOT NULL AND project_item_id IS NOT NULL)
  )
);

CREATE INDEX jobs_batch_updated ON jobs (batch_id, updated_at);
CREATE INDEX jobs_state_updated ON jobs (state, updated_at);

CREATE TABLE cache_entries (
  cache_key TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  validated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL
);

CREATE TABLE runtime_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE mcp_credentials (
  id TEXT PRIMARY KEY,
  token_identifier TEXT NOT NULL UNIQUE,
  token_verifier TEXT NOT NULL,
  name TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  media_scope_json TEXT NOT NULL,
  project_scope_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  unattended_exports INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE mcp_audit_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  credential_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL,
  resource_ids_json TEXT NOT NULL,
  job_id TEXT,
  occurred_at TEXT NOT NULL,
  FOREIGN KEY (credential_id) REFERENCES mcp_credentials (id)
);

CREATE INDEX mcp_credentials_created_at ON mcp_credentials (created_at DESC, id);
CREATE INDEX mcp_credentials_active ON mcp_credentials (revoked_at, expires_at);
CREATE INDEX mcp_audit_credential_id ON mcp_audit_entries (credential_id, id DESC);

