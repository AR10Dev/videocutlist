-- Current SQLite schema contract.
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  root_alias TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  parent_folder_id TEXT NOT NULL DEFAULT '',
  size_bytes INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  metadata_json TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (root_alias, relative_path)
);
CREATE INDEX media_available_id ON media (available, id);
CREATE INDEX media_available_parent_id ON media (available, parent_folder_id, id);

CREATE TABLE media_folders (
  id TEXT PRIMARY KEY,
  root_alias TEXT NOT NULL,
  parent_folder_id TEXT NOT NULL,
  label TEXT NOT NULL,
  available INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX media_folders_available_parent_id ON media_folders (available, parent_folder_id, id);
CREATE INDEX media_folders_root_alias ON media_folders (root_alias);

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
  proposal_id TEXT,
  credential_id TEXT,
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
CREATE INDEX jobs_state_created_id ON jobs (state, created_at, id);
CREATE UNIQUE INDEX jobs_proposal_item ON jobs (proposal_id, project_item_id) WHERE proposal_id IS NOT NULL;

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

CREATE TABLE export_proposals (
  id TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL,
  project_id TEXT,
  project_revision INTEGER NOT NULL CHECK (project_revision >= 0),
  payload_json TEXT NOT NULL,
  findings_json TEXT NOT NULL,
  requires_reencoding INTEGER NOT NULL CHECK (requires_reencoding IN (0, 1)),
  accuracy TEXT NOT NULL CHECK (accuracy IN ('frame_exact', 'keyframe_limited', 'mixed')),
  destination_id TEXT NOT NULL CHECK (destination_id = 'download'),
  expires_at TEXT NOT NULL,
  approved_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (credential_id) REFERENCES mcp_credentials (id),
  FOREIGN KEY (project_id) REFERENCES projects (id)
);

CREATE INDEX export_proposals_credential_created ON export_proposals (credential_id, created_at DESC);
CREATE INDEX export_proposals_expiry ON export_proposals (expires_at);
