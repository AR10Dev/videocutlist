-- Add the folder lookup index without changing the historical media table definition.
ALTER TABLE media ADD COLUMN parent_folder_id TEXT NOT NULL DEFAULT '';

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
