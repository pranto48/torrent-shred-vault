# Torrent Shred Vault Build Policy

## Current Phase

Phase 3 hardens the Docker web/API control plane and Windows desktop sync client. Android remains a later phase and must use the API contracts documented here instead of direct database access.

## Already Built

- Docker Compose stack with web, API, Postgres, optional legacy MinIO, updater, and backup services.
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
- Admin backup/restore workflow:
  - `backup` sidecar uses `pg_dump`, `pg_restore`, Docker CLI, and Compose.
  - Backups include Postgres plus a non-secret config manifest.
  - Backups are encrypted with `BACKUP_ENCRYPTION_KEY`.
  - MinIO/vault blob bytes are excluded by default.
- Desktop sync metadata in Postgres:
  - `sync_devices`
  - `sync_file_versions`
  - `sync_tombstones`
  - `sync_changes`
- Peer sync metadata in Postgres:
  - `sync_peer_sources`
  - `sync_peer_pieces`
  - peer endpoint presence in `sync_devices`
- Desktop sync API surface:
  - `GET /api/sync/bootstrap`
  - `GET /api/sync/changes`
  - `POST /api/sync/peer/register`
  - `POST /api/sync/peer/availability`
  - `POST /api/sync/peer/tickets/validate`
  - `POST /api/sync/files/register`
  - `POST /api/sync/files/delete`
  - `POST /api/sync/folders/create`
  - `POST /api/sync/folders/delete`
  - `POST /api/sync/ack`
- Windows desktop client foundation in `desktop/`:
  - React/Tauri UI for setup, login, status, conflicts, queue state, and software updates.
  - Local SQLite state for settings, sync queue, sync state, conflicts, and activity history.
  - Recursive filesystem watcher on `User Vault` and `Share Folder`.
  - Background sync loop with queue processing, cursor-based remote pull, tombstones, and conflict copy preservation.
  - Background peer listener for direct desktop-to-desktop file transfer.
  - Windows startup toggle, background-close behavior, push-only mode, and live transfer progress.
  - Startup panic/error logging to `%LOCALAPPDATA%\TorrentShredVaultDesktop\logs\desktop.log`.
  - Local sync reset and log-folder controls.
  - Piece-level peer downloads with per-piece hash validation and resume from verified part files.
  - Configurable desktop bandwidth limit in KB/s.
  - Optional Windows Credential Manager storage through the Rust `keyring` crate.
  - GitHub release update check and installer download action from the desktop app.

## Docker Deployment Rules

- Public web URL: `http://192.168.20.5:4400/`.
- Only the web container publishes a port by default.
- Nginx proxies `/api/*` to the API container.
- Postgres remains the required internal Docker data service.
- Desktop sync defaults to peer transport, so the Docker API stores auth, quotas, metadata, and peer discovery only.
- Deployment secrets must be supplied through `.env` or server environment variables, not committed to git.
- Fresh Docker installs currently seed the admin login as `mail@arifmahmud.com` / `password`; change it immediately after the first login.

Required production environment values:

```env
WEB_PORT=4400
PUBLIC_APP_URL=
DEFAULT_ADMIN_EMAIL=mail@arifmahmud.com
DEFAULT_ADMIN_PASSWORD=password
JWT_SECRET=replace-with-long-random-secret
SHARE_VAULT_SECRET=replace-with-long-random-share-secret
PEER_TRANSFER_SECRET=replace-with-long-random-peer-secret
BACKUP_ENCRYPTION_KEY=replace-with-long-random-backup-encryption-key
SYNC_TRANSPORT_MODE=peer
PEER_DEFAULT_PORT=44888
POSTGRES_PASSWORD=replace-with-private-db-password
UPDATE_REPO_URL=https://github.com/pranto48/torrent-shred-vault.git
UPDATE_REPO_BRANCH=main
```

Leave `PUBLIC_APP_URL` blank to use the current request host automatically, or set it explicitly when the deployment must advertise a fixed LAN address.

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
- `GET /api/sync/bootstrap`
- `GET /api/sync/changes?cursor=...&deviceId=...`
- `POST /api/sync/peer/register`
- `POST /api/sync/peer/availability`
- `POST /api/sync/peer/tickets/validate`
- `POST /api/sync/files/register`
- `POST /api/sync/files/delete`
- `POST /api/sync/folders/create`
- `POST /api/sync/folders/delete`
- `POST /api/sync/ack`
- `GET /api/admin/backups`
- `POST /api/admin/backups/create`
- `GET /api/admin/backups/:id/download`
- `POST /api/admin/backups/upload`
- `POST /api/admin/backups/:id/restore`
- `GET /api/admin/backups/status`

Private vault unlock remains controlled by the web/API account and recovery flow. In peer mode the desktop clients transfer file bytes directly; the Docker API authorizes the transfer and advertises live peers.

## Desktop Client Requirements

- Provide a Windows desktop app with two local folders:
  - `User Vault`
  - `Share Folder`
- Authenticate against `http://192.168.20.5:4400/`.
- Store only the JWT and client configuration locally; never store the raw password unless the user explicitly enables OS-protected credential storage.
- Persist desktop sync state in a local SQLite database.
- Watch local folders, register metadata through `/api/sync/files/register`, and publish peer availability through `/api/sync/peer/availability`.
- Download remote changes through `/api/sync/changes` and direct desktop peer transfer.
- Convert deletes into tombstones and preserve overwritten local edits as `*.conflict-<device>-<timestamp>`.
- Stay running in the background, auto-start on Windows sign-in when enabled, and show large-transfer progress similar to OneDrive.
- Support piece-level peer transfer for large files, resume already verified pieces after interruption, and throttle transfer speed when a bandwidth limit is set.
- Offer desktop software update checks from GitHub Releases.
- Future torrent/raid sync must use the 5GB raid reserve and must not bypass web/API authorization.

## Android Client Requirements

- Authenticate with the same API.
- Show the same two-drive model.
- Use metadata and peer-discovery APIs only; do not treat Docker as a blob store.
- Use Android Keystore for token and optional password protection.

## Torrent/Raid Sync Rules

- The first 5GB is user-controlled file data.
- The second 5GB is reserved for future raid/torrent redundancy.
- Raid metadata is tracked in Postgres and now drives shard placement, reserve-host assignments, and repair state.
- Peer transport is now used for desktop sync; Docker remains metadata-only for that path.
- Private vault files use a `2 data + 1 parity` manifest model with quorum `2`.
- Source devices publish file availability; reserve peers host shard `1` and shard `2` on distinct devices when capacity allows.
- Reserve-host health is based on live peer heartbeats. Stale peers degrade the manifest and trigger repair assignments.
- Desktop clients reconstruct missing private files from hosted shards when no direct full-file peer source is available.
- Large peer files publish block manifests through `sync_peer_pieces`; clients verify each piece hash and assemble the file locally.
- Remote desktop sync requires routable LAN or VPN networking in this phase.
- The web portal exposes user RAID reserve health and a repair/rebalance command.
- The admin panel exposes separate menus for Overview, Users, RAID Reserve, Backups, System Update, and Settings.

## Phase 3 Status

Completed in this phase:

- Desktop scaffold replaced with a real operations UI.
- Sync backend and cursor contract implemented.
- Desktop watcher, queue, local state, and update-check flow implemented.
- Metadata-only peer registration and direct desktop-to-desktop sync transport implemented for the Windows client path.
- RAID reserve metadata, shard assignment, host confirmation, and protected/degraded status transitions implemented for desktop peer mode.
- RAID repair/rebalance API and web controls implemented for user and admin workflows.
- Desktop release startup no longer exits through `.expect(...)`; startup failures are logged and shown in a native error dialog.
- Admin DB/config backup create, list, download, upload, and restore plumbing implemented.
- `desktop/dist`, `cargo check`, Docker build, and Tauri release build verification passing.

Still pending after this phase:

- Tauri updater plugin with signed in-app install/restart flow.
- Android client implementation.
- NAT traversal, peer certificates, and full torrent swarm strategy beyond LAN/VPN routable peers.

## Phase 3 Target

Phase 3 removes Docker-host blob storage and replaces it with metadata-only coordination plus desktop-to-desktop encrypted transport.

See [PEER_SYNC_PHASE3.md](./PEER_SYNC_PHASE3.md).
