-- Preview cache metadata. Filesystem publication remains temp + validated rename.
CREATE TABLE IF NOT EXISTS cache_entries (
    cache_key TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    validated_at TEXT NOT NULL,
    accessed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cache_entries_accessed_at ON cache_entries (
    accessed_at
);
