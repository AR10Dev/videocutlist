CREATE TABLE IF NOT EXISTS command_admissions (
    command_scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL COLLATE BINARY,
    command_kind TEXT NOT NULL,
    command_target TEXT NOT NULL,
    payload_digest TEXT NOT NULL,
    resource_refs_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (command_scope, idempotency_key)
);
