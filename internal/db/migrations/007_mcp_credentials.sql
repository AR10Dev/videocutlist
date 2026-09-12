-- Scoped MCP credentials and bounded audit records. Token plaintext is never persisted.
CREATE TABLE IF NOT EXISTS mcp_credentials (
    id TEXT PRIMARY KEY,
    token_identifier TEXT NOT NULL UNIQUE,
    token_verifier TEXT NOT NULL,
    name TEXT NOT NULL,
    permissions_json TEXT NOT NULL,
    media_scope_json TEXT NOT NULL,
    project_scope_json TEXT NOT NULL,
    expires_at TEXT,
    revoked_at TEXT,
    unattended_exports INTEGER NOT NULL DEFAULT 0 CHECK (unattended_exports IN (0, 1)),
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS mcp_credentials_created_at ON mcp_credentials (created_at DESC, id);
CREATE INDEX IF NOT EXISTS mcp_credentials_active ON mcp_credentials (revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS mcp_audit_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    credential_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    outcome TEXT NOT NULL,
    resource_ids_json TEXT NOT NULL,
    job_id TEXT,
    occurred_at TEXT NOT NULL,
    FOREIGN KEY (credential_id) REFERENCES mcp_credentials (id)
);

CREATE INDEX IF NOT EXISTS mcp_audit_credential_id ON mcp_audit_entries (credential_id, id DESC);
