CREATE TABLE IF NOT EXISTS runtime_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    schema_version INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    document_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
