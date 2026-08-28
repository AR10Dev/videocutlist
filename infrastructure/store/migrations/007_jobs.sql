CREATE TABLE IF NOT EXISTS jobs (
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
    CHECK ((kind = 'library_scan' AND project_id IS NULL AND project_item_id IS NULL) OR (kind != 'library_scan' AND project_id IS NOT NULL AND project_item_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS jobs_batch_updated ON jobs (batch_id, updated_at);
CREATE INDEX IF NOT EXISTS jobs_state_updated ON jobs (state, updated_at);
