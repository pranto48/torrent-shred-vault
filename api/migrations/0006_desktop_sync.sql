ALTER TABLE vault_items
  ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS content_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS last_change_cursor BIGINT;

CREATE TABLE IF NOT EXISTS sync_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'windows',
  local_roots JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_cursor BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS sync_file_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  content_sha256 TEXT,
  item_type TEXT NOT NULL CHECK (item_type IN ('file', 'folder')),
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, path)
);

CREATE TABLE IF NOT EXISTS sync_tombstones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_by_device_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, path, revision)
);

CREATE TABLE IF NOT EXISTS sync_changes (
  cursor BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  device_id TEXT,
  path TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file', 'folder')),
  operation TEXT NOT NULL CHECK (operation IN ('file_upsert', 'file_delete', 'folder_create', 'folder_delete')),
  revision INTEGER NOT NULL,
  file_id UUID,
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS sync_changes_user_cursor_idx ON sync_changes (user_id, cursor);
CREATE INDEX IF NOT EXISTS sync_changes_vault_path_idx ON sync_changes (vault_id, path, revision);
