CREATE TABLE IF NOT EXISTS user_security (
  user_id UUID PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  salt BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS vault_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  key_version INTEGER NOT NULL DEFAULT 1,
  wrapped_dek BYTEA NOT NULL,
  wrap_iv BYTEA NOT NULL,
  wrap_tag BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (vault_id, key_version)
);
