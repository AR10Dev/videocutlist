CREATE TABLE IF NOT EXISTS detection_jobs (
    id TEXT PRIMARY KEY, owner_login TEXT NOT NULL, project_id TEXT NOT NULL,
    media_id TEXT NOT NULL,
    project_revision INTEGER NOT NULL CHECK (project_revision > 0),
    kind TEXT NOT NULL CHECK (kind IN ('silence', 'black', 'scene')),
    state TEXT NOT NULL CHECK (
        state IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
    ),
    result_json TEXT,
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS detection_jobs_owner_updated ON detection_jobs (
    owner_login, updated_at DESC
);
