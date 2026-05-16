ALTER TABLE sync_devices
  ADD COLUMN IF NOT EXISTS peer_endpoint_url TEXT,
  ADD COLUMN IF NOT EXISTS peer_port INTEGER,
  ADD COLUMN IF NOT EXISTS peer_transport TEXT NOT NULL DEFAULT 'server',
  ADD COLUMN IF NOT EXISTS peer_last_seen_at TIMESTAMPTZ;

ALTER TABLE vault_items
  ADD COLUMN IF NOT EXISTS storage_backend TEXT NOT NULL DEFAULT 'server',
  ADD COLUMN IF NOT EXISTS source_device_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'vault_items_storage_backend_check'
  ) THEN
    ALTER TABLE vault_items
      ADD CONSTRAINT vault_items_storage_backend_check
      CHECK (storage_backend IN ('server', 'peer'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sync_peer_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('user_vault', 'share_vault')),
  path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, path, device_id)
);

CREATE INDEX IF NOT EXISTS sync_peer_sources_lookup_idx
  ON sync_peer_sources (user_id, vault_id, path, revision, updated_at DESC);
