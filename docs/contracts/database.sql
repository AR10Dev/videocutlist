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
  owner_login TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE export_jobs (
  id TEXT PRIMARY KEY,
  owner_login TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  request_json TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE cache_entries (
  cache_key TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  validated_at TEXT NOT NULL,
  accessed_at TEXT NOT NULL
);

