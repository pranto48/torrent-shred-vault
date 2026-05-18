ALTER TABLE sync_devices
  ADD COLUMN IF NOT EXISTS reserve_capacity_bytes BIGINT NOT NULL DEFAULT 5368709120,
  ADD COLUMN IF NOT EXISTS reserve_enabled BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS raid_manifests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  file_id UUID REFERENCES vault_items(id) ON DELETE SET NULL,
  root_kind TEXT NOT NULL CHECK (root_kind IN ('user_vault', 'share_vault')),
  path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  shard_bytes BIGINT NOT NULL DEFAULT 0,
  content_sha256 TEXT NOT NULL,
  source_device_id TEXT NOT NULL,
  data_shard_count INTEGER NOT NULL DEFAULT 2,
  parity_shard_count INTEGER NOT NULL DEFAULT 1,
  quorum_count INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'protected', 'degraded', 'repairing', 'superseded', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, path, revision)
);

CREATE TABLE IF NOT EXISTS raid_shards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES raid_manifests(id) ON DELETE CASCADE,
  shard_index INTEGER NOT NULL,
  shard_role TEXT NOT NULL CHECK (shard_role IN ('data', 'parity')),
  size_bytes BIGINT NOT NULL DEFAULT 0,
  sha256 TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (manifest_id, shard_index)
);

CREATE TABLE IF NOT EXISTS raid_shard_hosts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shard_id UUID NOT NULL REFERENCES raid_shards(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  host_device_id TEXT NOT NULL,
  endpoint_url TEXT,
  local_path TEXT,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'assigned'
    CHECK (status IN ('assigned', 'available', 'repairing', 'stale', 'deleted')),
  last_confirmed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shard_id, host_device_id)
);

CREATE TABLE IF NOT EXISTS raid_repair_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id UUID NOT NULL REFERENCES raid_manifests(id) ON DELETE CASCADE,
  shard_id UUID NOT NULL REFERENCES raid_shards(id) ON DELETE CASCADE,
  source_device_id TEXT,
  target_device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  failure_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS raid_manifests_lookup_idx
  ON raid_manifests (user_id, vault_id, path, revision DESC);

CREATE INDEX IF NOT EXISTS raid_shard_hosts_device_idx
  ON raid_shard_hosts (user_id, host_device_id, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS raid_repair_jobs_target_idx
  ON raid_repair_jobs (target_device_id, status, updated_at DESC);
