# Torrent Shred Vault Build Policy

## Current Phase

Phase 1 builds the Docker web/API application only. Windows desktop and Android clients are planned for the next phase and must use the API contracts documented here instead of direct database or MinIO access.

## Already Built

- Docker Compose stack with web, API, Postgres, MinIO, and updater services.
- Local JWT authentication with `admin` and `user` roles.
- Default two-vault model per user:
  - `user_vault` for private files.
  - `share_vault` for files visible to authenticated users.
- 10GB package policy:
  - 10GB total vault package.
  - 5GB user-upload quota.
  - 5GB raid/torrent reserve.
- AES-256-GCM encrypted file storage in MinIO with metadata in Postgres.
- Admin update workflow that checks GitHub `main`, rebuilds Docker images, and recreates containers without deleting volumes.
- The updater refuses to reset a dirty checkout unless `ALLOW_DIRTY_UPDATE=true` is set.

## Docker Deployment Rules

- Public web URL: `http://192.168.20.5:4400/`.
- Only the web container publishes a port by default.
- Nginx proxies `/api/*` to the API container.
- Postgres and MinIO remain internal Docker services with persistent volumes.
- Deployment secrets must be supplied through `.env` or server environment variables, not committed to git.

Required production environment values:

```env
WEB_PORT=4400
PUBLIC_APP_URL=http://192.168.20.5:4400
DEFAULT_ADMIN_EMAIL=mail@arifmahmud.com
DEFAULT_ADMIN_PASSWORD=replace-with-private-admin-password
JWT_SECRET=replace-with-long-random-secret
SHARE_VAULT_SECRET=replace-with-long-random-share-secret
POSTGRES_PASSWORD=replace-with-private-db-password
MINIO_ROOT_PASSWORD=replace-with-private-minio-password
UPDATE_REPO_URL=https://github.com/pranto48/torrent-shred-vault.git
UPDATE_REPO_BRANCH=main
```

## API Contract For Future Clients

Clients must authenticate through the web API:

- `POST /api/auth/login`
- `GET /api/me`
- `GET /api/vaults`
- `GET /api/files?vaultId=&path=`
- `POST /api/files/upload?vaultId=&path=`
- `GET /api/files/:fileId/download`
- `GET /api/share/files`
- `GET /api/share/files/:fileId/download`
- `GET /api/client/config`
- `GET /api/client/downloads`

Private vault upload/download requires the user password in `x-vault-password`. Shared-vault downloads are allowed for authenticated users through a server-side shared wrapping key.

## Desktop Client Requirements

- Provide a Windows tray app with two local folders:
  - `User Vault`
  - `Share Folder`
- Authenticate against `http://192.168.20.5:4400/`.
- Store only the JWT and client configuration locally; never store the raw password unless the user explicitly enables OS-protected credential storage.
- Watch local folders and upload changed files through `/api/files/upload`.
- Download remote changes through `/api/files/:fileId/download`.
- Future torrent/raid sync must use the 5GB raid reserve and must not bypass web/API authorization.

## Android Client Requirements

- Authenticate with the same API.
- Show the same two-drive model.
- Upload/download through API endpoints only.
- Use Android Keystore for token and optional password protection.

## Torrent/Raid Sync Rules

- The first 5GB is user-controlled file data.
- The second 5GB is reserved for future raid/torrent redundancy.
- Raid metadata must be tracked in Postgres before any peer-to-peer transport is enabled.
- Peer clients must never receive plaintext private-vault data.
- Shared-vault plaintext can only be returned by authenticated API download endpoints.
