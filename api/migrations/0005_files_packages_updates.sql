CREATE TABLE IF NOT EXISTS vault_packages (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  total_quota_bytes BIGINT NOT NULL DEFAULT 10737418240,
  user_quota_bytes BIGINT NOT NULL DEFAULT 5368709120,
  raid_reserve_bytes BIGINT NOT NULL DEFAULT 5368709120,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vault_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  parent_path TEXT NOT NULL DEFAULT '/',
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  item_type TEXT NOT NULL CHECK (item_type IN ('file', 'folder')),
  mime_type TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, path)
);

CREATE INDEX IF NOT EXISTS vault_items_vault_parent_idx ON vault_items (vault_id, parent_path);

CREATE TABLE IF NOT EXISTS file_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id UUID NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  enc_iv BYTEA NOT NULL,
  enc_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (file_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS vault_server_keys (
  vault_id UUID PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL DEFAULT 1,
  wrapped_dek BYTEA NOT NULL,
  wrap_iv BYTEA NOT NULL,
  wrap_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS system_update_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status TEXT NOT NULL,
  local_sha TEXT,
  remote_sha TEXT,
  message TEXT,
  logs TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
