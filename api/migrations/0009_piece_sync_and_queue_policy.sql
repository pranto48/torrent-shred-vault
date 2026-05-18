CREATE TABLE IF NOT EXISTS sync_peer_pieces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('user_vault', 'share_vault')),
  path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  piece_index INTEGER NOT NULL,
  piece_size_bytes BIGINT NOT NULL DEFAULT 0,
  offset_bytes BIGINT NOT NULL DEFAULT 0,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, path, revision, device_id, piece_index)
);

CREATE INDEX IF NOT EXISTS sync_peer_pieces_lookup_idx
  ON sync_peer_pieces (user_id, vault_id, path, revision, piece_index, updated_at DESC);

ALTER TABLE sync_devices
  ADD COLUMN IF NOT EXISTS bandwidth_limit_kbps INTEGER;
