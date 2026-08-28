CREATE TABLE IF NOT EXISTS export_jobs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    request_json TEXT NOT NULL,
    result_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects (id)
);

CREATE INDEX IF NOT EXISTS export_jobs_state_updated ON export_jobs (
    state, updated_at
);
