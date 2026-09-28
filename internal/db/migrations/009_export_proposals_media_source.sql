-- Allow MCP export proposals to be bound to explicit media/ranges without a project.
CREATE TABLE IF NOT EXISTS export_proposals_v2 (
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
INSERT OR IGNORE INTO export_proposals_v2
(id, credential_id, project_id, project_revision, payload_json, findings_json, requires_reencoding, accuracy, destination_id, expires_at, approved_at, created_at)
SELECT id, credential_id, project_id, project_revision, payload_json, findings_json, requires_reencoding, accuracy, destination_id, expires_at, approved_at, created_at
FROM export_proposals;
DROP TABLE export_proposals;
ALTER TABLE export_proposals_v2 RENAME TO export_proposals;
CREATE INDEX IF NOT EXISTS export_proposals_credential_created
    ON export_proposals (credential_id, created_at DESC);
CREATE INDEX IF NOT EXISTS export_proposals_expiry ON export_proposals (expires_at);
