import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, runMigrations } from './db.js';
import { authenticate, authorize, signToken } from './auth.js';
import {
  decryptChunk,
  deriveKek,
  encryptChunk,
  generateDek,
  hashPassword,
  sha256Hex,
  unwrapDek,
  verifyPassword,
  wrapDek,
} from './crypto.js';
import { ensureBucket, getBucketName, minioClient } from './storage.js';

const app = express();
app.use(cors());
app.use((req, res, next) => {
  if (
    req.path === '/api/files/upload'
    || req.path === '/api/sync/files/upload'
    || req.path === '/api/chunks/upload'
    || req.path === '/api/admin/backups/upload'
  ) return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

const TEN_GB = 10 * 1024 * 1024 * 1024;
const FIVE_GB = 5 * 1024 * 1024 * 1024;
const FILE_UPLOAD_LIMIT = process.env.FILE_UPLOAD_LIMIT ?? '200mb';
const UPDATER_URL = process.env.UPDATER_URL ?? 'http://updater:3100';
const BACKUP_URL = process.env.BACKUP_URL ?? 'http://backup:3200';
const SHARE_VAULT_SECRET = process.env.SHARE_VAULT_SECRET ?? process.env.JWT_SECRET ?? 'change-this-in-production';
const PEER_TRANSFER_SECRET = process.env.PEER_TRANSFER_SECRET ?? SHARE_VAULT_SECRET;
const PUBLIC_APP_URL = process.env.PUBLIC_APP_URL?.trim() ?? '';
const DESKTOP_RELEASE_REPO = process.env.DESKTOP_RELEASE_REPO ?? 'pranto48/torrent-shred-vault';
const DESKTOP_RELEASE_URL = process.env.DESKTOP_RELEASE_URL ?? `https://github.com/${DESKTOP_RELEASE_REPO}/releases/latest`;
const DESKTOP_CURRENT_VERSION = process.env.DESKTOP_CURRENT_VERSION ?? '0.2.0';
const SYNC_PAGE_SIZE = Number(process.env.SYNC_PAGE_SIZE ?? 250);
const SYNC_TRANSPORT_MODE = process.env.SYNC_TRANSPORT_MODE === 'server' ? 'server' : 'peer';
const PEER_SOURCE_TTL_SECONDS = Number(process.env.PEER_SOURCE_TTL_SECONDS ?? 90);
const PEER_DEFAULT_PORT = Number(process.env.PEER_DEFAULT_PORT ?? 44888);
const RAID_DATA_SHARDS = 2;
const RAID_PARITY_SHARDS = 1;
const RAID_TOTAL_SHARDS = RAID_DATA_SHARDS + RAID_PARITY_SHARDS;
const RAID_QUORUM_SHARDS = 2;

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['user', 'admin']).optional(),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const changePasswordSchema = z.object({
  currentPassword: z.string().min(8),
  newPassword: z.string().min(8),
});
const adminResetPasswordSchema = z.object({
  newPassword: z.string().min(8),
});
const createVaultSchema = z.object({
  type: z.enum(['user_vault', 'share_vault']),
  name: z.string().min(1).max(120).optional(),
});
const folderSchema = z.object({
  vaultId: z.string().uuid(),
  path: z.string().optional(),
  name: z.string().min(1).max(180),
});
const syncFolderCreateSchema = z.object({
  deviceId: z.string().min(1).max(120),
  rootKind: z.enum(['user_vault', 'share_vault']),
  parentPath: z.string().optional(),
  name: z.string().min(1).max(180),
});
const syncPathDeleteSchema = z.object({
  deviceId: z.string().min(1).max(120),
  rootKind: z.enum(['user_vault', 'share_vault']),
  relativePath: z.string().min(1),
});
const syncAckSchema = z.object({
  deviceId: z.string().min(1).max(120),
  cursor: z.coerce.number().int().nonnegative(),
  localRoots: z.record(z.string()).optional(),
});
const syncPeerRegisterSchema = z.object({
  deviceId: z.string().min(1).max(120),
  endpointUrl: z.string().url(),
  peerPort: z.coerce.number().int().min(1).max(65535).optional(),
  reserveCapacityBytes: z.coerce.number().int().positive().max(FIVE_GB).optional(),
  reserveEnabled: z.boolean().optional(),
  localRoots: z.record(z.string()).optional(),
});
const syncPeerAvailabilitySchema = z.object({
  deviceId: z.string().min(1).max(120),
  rootKind: z.enum(['user_vault', 'share_vault']),
  relativePath: z.string().min(1),
  revision: z.coerce.number().int().nonnegative().optional(),
  sizeBytes: z.coerce.number().int().nonnegative(),
  sha256: z.string().min(16).max(128),
  present: z.boolean().optional(),
  pieces: z.array(z.object({
    index: z.coerce.number().int().nonnegative(),
    pieceSizeBytes: z.coerce.number().int().positive(),
    offsetBytes: z.coerce.number().int().nonnegative(),
    sizeBytes: z.coerce.number().int().nonnegative(),
    sha256: z.string().min(16).max(128),
  })).optional(),
});
const syncFileRegisterSchema = z.object({
  deviceId: z.string().min(1).max(120),
  rootKind: z.enum(['user_vault', 'share_vault']),
  relativePath: z.string().min(1),
  mimeType: z.string().max(180).optional(),
  sizeBytes: z.coerce.number().int().nonnegative(),
  sha256: z.string().min(16).max(128),
});
const syncPeerTicketValidateSchema = z.object({
  ticket: z.string().min(32),
  deviceId: z.string().min(1).max(120).optional(),
});
const syncRaidRegisterSchema = z.object({
  deviceId: z.string().min(1).max(120),
  rootKind: z.enum(['user_vault', 'share_vault']),
  relativePath: z.string().min(1),
  revision: z.coerce.number().int().positive(),
  sizeBytes: z.coerce.number().int().nonnegative(),
  sha256: z.string().min(16).max(128),
  shardBytes: z.coerce.number().int().nonnegative(),
  shards: z.array(
    z.object({
      index: z.coerce.number().int().min(0).max(RAID_TOTAL_SHARDS - 1),
      role: z.enum(['data', 'parity']),
      sizeBytes: z.coerce.number().int().nonnegative(),
      sha256: z.string().min(16).max(128),
    }),
  ).length(RAID_TOTAL_SHARDS),
});
const syncRaidHostConfirmSchema = z.object({
  deviceId: z.string().min(1).max(120),
  hostId: z.string().uuid(),
  manifestId: z.string().uuid(),
  shardId: z.string().uuid(),
  localPath: z.string().min(1).max(500).optional(),
  sizeBytes: z.coerce.number().int().nonnegative(),
  sha256: z.string().min(16).max(128),
});
const adminRaidRepairSchema = z.object({
  userId: z.string().uuid().optional(),
});

function sanitizeDeviceId(value) {
  return String(value ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '-')
    .slice(0, 120);
}

function normalizeRelativePath(input = '/') {
  return normalizeDirPath(input);
}

function serverKek() {
  return crypto.createHash('sha256').update(SHARE_VAULT_SECRET).digest();
}

function normalizeDirPath(input = '/') {
  const cleaned = `/${String(input).replaceAll('\\', '/').replace(/^\/+|\/+$/g, '')}`;
  return cleaned === '/.' ? '/' : cleaned.replace(/\/+/g, '/');
}

function normalizeItemName(name) {
  const cleaned = String(name).replaceAll('\\', '/').split('/').filter(Boolean).join('-').trim();
  if (!cleaned || cleaned === '.' || cleaned === '..') throw new Error('Invalid file or folder name');
  return cleaned.slice(0, 180);
}

function joinVaultPath(parentPath, name) {
  const parent = normalizeDirPath(parentPath);
  const itemName = normalizeItemName(name);
  return parent === '/' ? `/${itemName}` : `${parent}/${itemName}`;
}

function contentDispositionName(name) {
  return String(name).replace(/["\r\n]/g, '_');
}

function getPublicAppUrl(req) {
  if (PUBLIC_APP_URL) return PUBLIC_APP_URL;
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = typeof forwardedProto === 'string' ? forwardedProto.split(',')[0].trim() : req.protocol ?? 'http';
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return `${proto}://${host}`;
}

function parentDirOf(itemPath) {
  const normalized = normalizeDirPath(itemPath);
  if (normalized === '/') return '/';
  const parts = normalized.split('/').filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join('/')}` : '/';
}

function rootLabelForVaultType(vaultType) {
  return vaultType === 'share_vault' ? 'Share Folder' : 'User Vault';
}

function nameOfPath(itemPath) {
  const normalized = normalizeDirPath(itemPath);
  const parts = normalized.split('/').filter(Boolean);
  return normalizeItemName(parts.pop() ?? '');
}

function isPeerMode() {
  return SYNC_TRANSPORT_MODE === 'peer';
}

function isRaidEligibleRoot(rootKind) {
  return rootKind === 'user_vault';
}

function signPeerTicket(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', PEER_TRANSFER_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

function verifyPeerTicket(ticket) {
  const [body, signature] = String(ticket ?? '').split('.');
  if (!body || !signature) throw new Error('Invalid peer ticket');
  const expected = crypto.createHmac('sha256', PEER_TRANSFER_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
    throw new Error('Invalid peer ticket signature');
  }
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload?.expiresAt || Number(payload.expiresAt) < Date.now()) {
    throw new Error('Peer ticket expired');
  }
  return payload;
}

async function getOwnedVaultByType(userId, vaultType) {
  const result = await pool.query('SELECT id, user_id, type, name FROM vaults WHERE user_id = $1 AND type = $2', [userId, vaultType]);
  return result.rows[0] ?? null;
}

async function ensureSyncDevice(
  client,
  userId,
  { deviceId, deviceName, platform, localRoots, peerEndpointUrl, peerPort, peerTransport, reserveCapacityBytes, reserveEnabled } = {},
) {
  const sanitizedDeviceId = sanitizeDeviceId(deviceId);
  if (!sanitizedDeviceId) throw new Error('Invalid device id');
  const result = await client.query(
    `INSERT INTO sync_devices (
       user_id, device_id, device_name, platform, local_roots, peer_endpoint_url, peer_port, peer_transport,
       peer_last_seen_at, reserve_capacity_bytes, reserve_enabled
     )
     VALUES (
       $1, $2, $3, $4, $5::jsonb, $6::text, $7::integer, COALESCE($8::text, 'server'),
       CASE WHEN $6::text IS NULL THEN NULL ELSE NOW() END, COALESCE($9::bigint, ${FIVE_GB}), COALESCE($10::boolean, TRUE)
     )
     ON CONFLICT (user_id, device_id)
     DO UPDATE SET
       device_name = EXCLUDED.device_name,
       platform = EXCLUDED.platform,
       local_roots = COALESCE(NULLIF(EXCLUDED.local_roots, '{}'::jsonb), sync_devices.local_roots),
       peer_endpoint_url = COALESCE(EXCLUDED.peer_endpoint_url, sync_devices.peer_endpoint_url),
       peer_port = COALESCE(EXCLUDED.peer_port, sync_devices.peer_port),
       reserve_capacity_bytes = COALESCE(EXCLUDED.reserve_capacity_bytes, sync_devices.reserve_capacity_bytes),
       reserve_enabled = COALESCE(EXCLUDED.reserve_enabled, sync_devices.reserve_enabled),
       peer_transport = CASE
         WHEN $8::text IS NULL THEN sync_devices.peer_transport
         ELSE EXCLUDED.peer_transport
       END,
       peer_last_seen_at = CASE
         WHEN EXCLUDED.peer_endpoint_url IS NULL THEN sync_devices.peer_last_seen_at
         ELSE NOW()
       END,
       updated_at = NOW()
     RETURNING id, user_id, device_id, device_name, platform, local_roots, last_cursor,
               peer_endpoint_url, peer_port, peer_transport, peer_last_seen_at,
               reserve_capacity_bytes, reserve_enabled, created_at, updated_at`,
    [
      userId,
      sanitizedDeviceId,
      String(deviceName ?? sanitizedDeviceId).slice(0, 160),
      String(platform ?? 'windows').slice(0, 40),
      JSON.stringify(localRoots ?? {}),
      peerEndpointUrl ? String(peerEndpointUrl).slice(0, 400) : null,
      Number.isFinite(peerPort) ? Number(peerPort) : null,
      peerTransport == null ? null : peerTransport === 'peer' ? 'peer' : 'server',
      Number.isFinite(reserveCapacityBytes) ? Number(reserveCapacityBytes) : null,
      typeof reserveEnabled === 'boolean' ? reserveEnabled : null,
    ],
  );
  return result.rows[0];
}

async function recordSyncChange(client, payload) {
  const result = await client.query(
    `INSERT INTO sync_changes (user_id, vault_id, device_id, path, item_type, operation, revision, file_id, mime_type, size_bytes, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING cursor, created_at`,
    [
      payload.userId,
      payload.vaultId,
      payload.deviceId ?? null,
      payload.path,
      payload.itemType,
      payload.operation,
      payload.revision,
      payload.fileId ?? null,
      payload.mimeType ?? null,
      payload.sizeBytes ?? 0,
      payload.sha256 ?? null,
    ],
  );
  const cursor = Number(result.rows[0].cursor);
  const deletedAt = payload.operation.endsWith('delete') ? new Date().toISOString() : null;
  await client.query(
    `INSERT INTO sync_file_versions (vault_id, path, revision, content_sha256, item_type, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (vault_id, path)
     DO UPDATE SET
       revision = EXCLUDED.revision,
       content_sha256 = EXCLUDED.content_sha256,
       item_type = EXCLUDED.item_type,
       deleted_at = EXCLUDED.deleted_at,
       updated_at = NOW()`,
    [payload.vaultId, payload.path, payload.revision, payload.sha256 ?? null, payload.itemType, deletedAt],
  );
  if (payload.operation.endsWith('delete')) {
    await client.query(
      `INSERT INTO sync_tombstones (vault_id, path, revision, deleted_by_device_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (vault_id, path, revision) DO NOTHING`,
      [payload.vaultId, payload.path, payload.revision, payload.deviceId ?? null],
    );
  } else {
    await client.query('DELETE FROM sync_tombstones WHERE vault_id = $1 AND path = $2', [payload.vaultId, payload.path]);
  }
  if (payload.fileId) {
    await client.query(
      'UPDATE vault_items SET revision = $2, content_sha256 = $3, last_change_cursor = $4, updated_at = NOW() WHERE id = $1',
      [payload.fileId, payload.revision, payload.sha256 ?? null, cursor],
    );
  }
  return cursor;
}

async function currentRevisionForPath(client, vaultId, itemPath) {
  const version = await client.query('SELECT revision FROM sync_file_versions WHERE vault_id = $1 AND path = $2', [vaultId, itemPath]);
  if (version.rowCount) return Number(version.rows[0].revision);
  const item = await client.query('SELECT revision FROM vault_items WHERE vault_id = $1 AND path = $2', [vaultId, itemPath]);
  return item.rowCount ? Number(item.rows[0].revision ?? 0) : 0;
}

async function createFolderEntry(client, { userId, vault, parentPath, name, deviceId }) {
  const path = joinVaultPath(parentPath, name);
  const existing = await client.query(
    `SELECT id, vault_id, parent_path, path, name, item_type, size_bytes, revision, created_at, updated_at
     FROM vault_items
     WHERE vault_id = $1 AND path = $2`,
    [vault.id, path],
  );
  if (existing.rowCount) {
    if (existing.rows[0].item_type !== 'folder') {
      const error = new Error('Path is occupied by a file');
      error.status = 409;
      throw error;
    }
    return existing.rows[0];
  }

  const folder = await client.query(
    `INSERT INTO vault_items (vault_id, parent_path, path, name, item_type, revision)
     VALUES ($1, $2, $3, $4, 'folder', 1)
     RETURNING id, vault_id, parent_path, path, name, item_type, size_bytes, revision, created_at, updated_at`,
    [vault.id, parentPath, path, name],
  );
  await recordSyncChange(client, {
    userId,
    vaultId: vault.id,
    deviceId,
    path,
    itemType: 'folder',
    operation: 'folder_create',
    revision: 1,
    fileId: folder.rows[0].id,
  });
  return folder.rows[0];
}

async function upsertFileEntry(client, { userId, vault, parentPath, name, plaintext, mimeType, password, deviceId }) {
  const itemPath = joinVaultPath(parentPath, name);
  const sha256 = sha256Hex(plaintext);
  const existing = await client.query(
    'SELECT id, item_type, revision FROM vault_items WHERE vault_id = $1 AND path = $2',
    [vault.id, itemPath],
  );
  if (existing.rowCount && existing.rows[0].item_type !== 'file') {
    const error = new Error('Path is occupied by a folder');
    error.status = 409;
    throw error;
  }

  const objectKey = `${vault.id}/${crypto.randomUUID()}.chunk`;
  const dek = await (vault.type === 'share_vault' ? resolveShareDek(vault.id).catch(async () => {
    await ensureServerWrappedVaultKey(vault, password);
    return resolveShareDek(vault.id);
  }) : resolveVaultDek(userId, vault.id, password));
  if (vault.type === 'share_vault') {
    await ensureServerWrappedVaultKey(vault, password);
  }
  const encrypted = encryptChunk(dek, plaintext);
  await minioClient.putObject(getBucketName(), objectKey, encrypted.ciphertext);

  let oldObjectKeys = [];
  try {
    let itemRow;
    let revision;
    if (existing.rowCount) {
      itemRow = existing.rows[0];
      revision = Number(itemRow.revision ?? 0) + 1;
      const priorChunks = await client.query('SELECT object_key FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index ASC', [itemRow.id]);
      oldObjectKeys = priorChunks.rows.map((row) => row.object_key);
      await client.query('DELETE FROM file_chunks WHERE file_id = $1', [itemRow.id]);
      const updated = await client.query(
        `UPDATE vault_items
         SET parent_path = $2, name = $3, mime_type = $4, size_bytes = $5, revision = $6, updated_at = NOW()
         WHERE id = $1
         RETURNING id, vault_id, parent_path, path, name, item_type, mime_type, size_bytes, revision, created_at, updated_at`,
        [itemRow.id, parentPath, name, mimeType, plaintext.length, revision],
      );
      itemRow = updated.rows[0];
    } else {
      revision = 1;
      const inserted = await client.query(
        `INSERT INTO vault_items (vault_id, parent_path, path, name, item_type, mime_type, size_bytes, revision)
         VALUES ($1, $2, $3, $4, 'file', $5, $6, $7)
         RETURNING id, vault_id, parent_path, path, name, item_type, mime_type, size_bytes, revision, created_at, updated_at`,
        [vault.id, parentPath, itemPath, name, mimeType, plaintext.length, revision],
      );
      itemRow = inserted.rows[0];
    }

    await client.query(
      `INSERT INTO file_chunks (file_id, chunk_index, object_key, sha256, size_bytes, enc_iv, enc_tag)
       VALUES ($1, 0, $2, $3, $4, $5, $6)`,
      [itemRow.id, objectKey, sha256, plaintext.length, encrypted.iv, encrypted.tag],
    );
    await recordSyncChange(client, {
      userId,
      vaultId: vault.id,
      deviceId,
      path: itemPath,
      itemType: 'file',
      operation: 'file_upsert',
      revision,
      fileId: itemRow.id,
      mimeType,
      sizeBytes: plaintext.length,
      sha256,
    });
    return { item: itemRow, oldObjectKeys, sha256 };
  } catch (error) {
    await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
    throw error;
  }
}

async function upsertPeerMetadataEntry(client, { userId, vault, itemPath, mimeType, sizeBytes, sha256, deviceId }) {
  const existing = await client.query(
    'SELECT id, item_type, revision FROM vault_items WHERE vault_id = $1 AND path = $2',
    [vault.id, itemPath],
  );
  if (existing.rowCount && existing.rows[0].item_type !== 'file') {
    const error = new Error('Path is occupied by a folder');
    error.status = 409;
    throw error;
  }

  const parentPath = parentDirOf(itemPath);
  const name = nameOfPath(itemPath);
  let oldObjectKeys = [];
  let itemRow;
  let revision;

  if (existing.rowCount) {
    itemRow = existing.rows[0];
    revision = Number(itemRow.revision ?? 0) + 1;
    const priorChunks = await client.query('SELECT object_key FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index ASC', [itemRow.id]);
    oldObjectKeys = priorChunks.rows.map((row) => row.object_key);
    await client.query('DELETE FROM file_chunks WHERE file_id = $1', [itemRow.id]);
    const updated = await client.query(
      `UPDATE vault_items
       SET parent_path = $2, name = $3, mime_type = $4, size_bytes = $5, revision = $6,
           content_sha256 = $7, storage_backend = 'peer', source_device_id = $8, updated_at = NOW()
       WHERE id = $1
       RETURNING id, vault_id, parent_path, path, name, item_type, mime_type, size_bytes, revision, content_sha256, storage_backend, created_at, updated_at`,
      [itemRow.id, parentPath, name, mimeType, sizeBytes, revision, sha256, deviceId],
    );
    itemRow = updated.rows[0];
  } else {
    revision = 1;
    const inserted = await client.query(
      `INSERT INTO vault_items (vault_id, parent_path, path, name, item_type, mime_type, size_bytes, revision, content_sha256, storage_backend, source_device_id)
       VALUES ($1, $2, $3, $4, 'file', $5, $6, $7, $8, 'peer', $9)
       RETURNING id, vault_id, parent_path, path, name, item_type, mime_type, size_bytes, revision, content_sha256, storage_backend, created_at, updated_at`,
      [vault.id, parentPath, itemPath, name, mimeType, sizeBytes, revision, sha256, deviceId],
    );
    itemRow = inserted.rows[0];
  }

  await recordSyncChange(client, {
    userId,
    vaultId: vault.id,
    deviceId,
    path: itemPath,
    itemType: 'file',
    operation: 'file_upsert',
    revision,
    fileId: itemRow.id,
    mimeType,
    sizeBytes,
    sha256,
  });
  return { item: itemRow, oldObjectKeys, sha256, revision };
}

async function deleteVaultPath(client, { userId, vault, itemPath, deviceId }) {
  const target = await client.query(
    `SELECT id, vault_id, path, item_type, revision
     FROM vault_items
     WHERE vault_id = $1 AND path = $2`,
    [vault.id, itemPath],
  );
  if (!target.rowCount) {
    const error = new Error('Item not found');
    error.status = 404;
    throw error;
  }

  const targets = await client.query(
    `SELECT id, path, item_type, COALESCE(revision, 0) AS revision
     FROM vault_items
     WHERE vault_id = $1 AND (path = $2 OR path LIKE $3)
     ORDER BY LENGTH(path) DESC`,
    [vault.id, itemPath, `${itemPath}/%`],
  );
  const ids = targets.rows.map((row) => row.id);
  const chunks = await client.query('SELECT object_key FROM file_chunks WHERE file_id = ANY($1::uuid[])', [ids]);
  for (const row of targets.rows) {
    const nextRevision = Number(row.revision ?? (await currentRevisionForPath(client, vault.id, row.path))) + 1;
    await recordSyncChange(client, {
      userId,
      vaultId: vault.id,
      deviceId,
      path: row.path,
      itemType: row.item_type,
      operation: row.item_type === 'folder' ? 'folder_delete' : 'file_delete',
      revision: nextRevision,
    });
  }
  await client.query('DELETE FROM vault_items WHERE id = ANY($1::uuid[])', [ids]);
  return { deleted: ids.length, objectKeys: chunks.rows.map((row) => row.object_key) };
}

async function listSyncChangesForUser(userId, cursor, deviceId) {
  const params = [userId, cursor];
  let filter = '';
  if (deviceId) {
    params.push(deviceId);
    filter = 'AND (device_id IS NULL OR device_id <> $3)';
  }
  const result = await pool.query(
    `SELECT cursor, vault_id, device_id, path, item_type, operation, revision, file_id, mime_type, size_bytes, sha256, created_at
     FROM sync_changes
     WHERE user_id = $1 AND cursor > $2 ${filter}
     ORDER BY cursor ASC
     LIMIT ${SYNC_PAGE_SIZE}`,
    params,
  );
  return result.rows;
}

function serializeSyncDevice(row) {
  return {
    ...row,
    last_cursor: Number(row.last_cursor ?? 0),
    peer_port: row.peer_port == null ? null : Number(row.peer_port),
    reserve_capacity_bytes: Number(row.reserve_capacity_bytes ?? FIVE_GB),
  };
}

function serializeSyncChange(row) {
  return {
    ...row,
    cursor: Number(row.cursor ?? 0),
    revision: Number(row.revision ?? 0),
    size_bytes: Number(row.size_bytes ?? 0),
  };
}

function peerTicketPayload({ userId, sourceDeviceId, targetDeviceId, vaultId, path, rootKind, kind = 'peer_file', pieceIndex = null, offsetBytes = null, sizeBytes = null, sha256 = null }) {
  return {
    kind,
    userId,
    sourceDeviceId,
    targetDeviceId,
    vaultId,
    path,
    rootKind,
    pieceIndex,
    offsetBytes,
    sizeBytes,
    sha256,
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
}

async function listPeerSourcesForPath(userId, vaultId, itemPath, excludeDeviceId, targetDeviceId, revision = null) {
  const params = [userId, vaultId, itemPath, PEER_SOURCE_TTL_SECONDS];
  let filter = '';
  let revisionFilter = '';
  if (Number.isFinite(revision)) {
    params.push(Number(revision));
    revisionFilter = `AND src.revision = $${params.length}`;
  }
  if (excludeDeviceId) {
    params.push(excludeDeviceId);
    filter = `AND src.device_id <> $${params.length}`;
  }
  const result = await pool.query(
    `SELECT src.device_id, src.root_kind, src.revision, src.size_bytes, src.sha256, src.updated_at,
            dev.peer_endpoint_url, dev.peer_port
     FROM sync_peer_sources src
     JOIN sync_devices dev ON dev.user_id = src.user_id AND dev.device_id = src.device_id
     WHERE src.user_id = $1
       AND src.vault_id = $2
       AND src.path = $3
       AND dev.peer_endpoint_url IS NOT NULL
       AND dev.peer_transport = 'peer'
       AND COALESCE(dev.peer_last_seen_at, dev.updated_at) >= NOW() - ($4 * INTERVAL '1 second')
       ${revisionFilter}
       ${filter}
     ORDER BY src.updated_at DESC`,
    params,
  );
  return result.rows.map((row) => ({
    device_id: row.device_id,
    endpoint_url: row.peer_endpoint_url,
    peer_port: row.peer_port == null ? null : Number(row.peer_port),
    revision: Number(row.revision ?? 0),
    size_bytes: Number(row.size_bytes ?? 0),
    sha256: row.sha256,
    ticket: signPeerTicket(
      peerTicketPayload({
        userId,
        sourceDeviceId: row.device_id,
        targetDeviceId,
        vaultId,
        path: itemPath,
        rootKind: row.root_kind,
      }),
    ),
  }));
}

async function listPeerPiecesForPath(userId, vaultId, itemPath, excludeDeviceId, targetDeviceId, revision = null) {
  const params = [userId, vaultId, itemPath, PEER_SOURCE_TTL_SECONDS];
  let filter = '';
  let revisionFilter = '';
  if (Number.isFinite(revision)) {
    params.push(Number(revision));
    revisionFilter = `AND piece.revision = $${params.length}`;
  }
  if (excludeDeviceId) {
    params.push(excludeDeviceId);
    filter = `AND piece.device_id <> $${params.length}`;
  }
  const result = await pool.query(
    `SELECT piece.device_id, piece.root_kind, piece.revision, piece.piece_index, piece.piece_size_bytes,
            piece.offset_bytes, piece.size_bytes, piece.sha256, piece.updated_at,
            dev.peer_endpoint_url, dev.peer_port
     FROM sync_peer_pieces piece
     JOIN sync_devices dev ON dev.user_id = piece.user_id AND dev.device_id = piece.device_id
     WHERE piece.user_id = $1
       AND piece.vault_id = $2
       AND piece.path = $3
       AND dev.peer_endpoint_url IS NOT NULL
       AND dev.peer_transport = 'peer'
       AND COALESCE(dev.peer_last_seen_at, dev.updated_at) >= NOW() - ($4 * INTERVAL '1 second')
       ${revisionFilter}
       ${filter}
     ORDER BY piece.piece_index ASC, piece.updated_at DESC`,
    params,
  );
  return result.rows.map((row) => ({
    device_id: row.device_id,
    endpoint_url: row.peer_endpoint_url,
    peer_port: row.peer_port == null ? null : Number(row.peer_port),
    revision: Number(row.revision ?? 0),
    piece_index: Number(row.piece_index ?? 0),
    piece_size_bytes: Number(row.piece_size_bytes ?? 0),
    offset_bytes: Number(row.offset_bytes ?? 0),
    size_bytes: Number(row.size_bytes ?? 0),
    sha256: row.sha256,
    ticket: signPeerTicket(
      peerTicketPayload({
        kind: 'peer_file_piece',
        userId,
        sourceDeviceId: row.device_id,
        targetDeviceId,
        vaultId,
        path: itemPath,
        rootKind: row.root_kind,
        pieceIndex: Number(row.piece_index ?? 0),
        offsetBytes: Number(row.offset_bytes ?? 0),
        sizeBytes: Number(row.size_bytes ?? 0),
        sha256: row.sha256,
      }),
    ),
  }));
}

async function serializeSyncChangeForUser(row, userId, requestDeviceId) {
  const serialized = serializeSyncChange(row);
  if (serialized.operation !== 'file_upsert' || !isPeerMode()) {
    return serialized;
  }
  serialized.peer_sources = await listPeerSourcesForPath(userId, serialized.vault_id, serialized.path, requestDeviceId, requestDeviceId, serialized.revision);
  serialized.peer_pieces = await listPeerPiecesForPath(userId, serialized.vault_id, serialized.path, requestDeviceId, requestDeviceId, serialized.revision);
  serialized.raid = await getRaidManifestSummary(userId, serialized.vault_id, serialized.path, serialized.revision, requestDeviceId);
  return serialized;
}

async function getRaidReserveUsage(client, userId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(size_bytes), 0)::BIGINT AS used_bytes
     FROM raid_shard_hosts
     WHERE user_id = $1 AND status IN ('assigned', 'available', 'repairing')`,
    [userId],
  );
  return Number(result.rows[0]?.used_bytes ?? 0);
}

async function listActivePeerDevices(client, userId, excludeDeviceIds = []) {
  const params = [userId, PEER_SOURCE_TTL_SECONDS];
  let excludeSql = '';
  if (excludeDeviceIds.length) {
    params.push(excludeDeviceIds.map((value) => sanitizeDeviceId(value)));
    excludeSql = `AND device_id <> ALL($${params.length}::text[])`;
  }
  const result = await client.query(
    `SELECT device_id, peer_endpoint_url, peer_port, reserve_capacity_bytes, reserve_enabled, updated_at,
            COALESCE(peer_last_seen_at, updated_at) AS heartbeat
     FROM sync_devices
     WHERE user_id = $1
       AND peer_transport = 'peer'
       AND peer_endpoint_url IS NOT NULL
       AND reserve_enabled = TRUE
       AND COALESCE(peer_last_seen_at, updated_at) >= NOW() - ($2 * INTERVAL '1 second')
       ${excludeSql}
     ORDER BY heartbeat DESC`,
    params,
  );
  return result.rows.map((row) => ({
    deviceId: row.device_id,
    endpointUrl: row.peer_endpoint_url,
    peerPort: row.peer_port == null ? null : Number(row.peer_port),
    reserveCapacityBytes: Number(row.reserve_capacity_bytes ?? FIVE_GB),
  }));
}

async function refreshRaidHealthForUser(client, userId) {
  await client.query(
    `UPDATE raid_shard_hosts h
     SET status = 'stale', updated_at = NOW()
     FROM sync_devices d
     WHERE h.user_id = $1
       AND h.user_id = d.user_id
       AND h.host_device_id = d.device_id
       AND h.status IN ('assigned', 'available', 'repairing')
       AND (
         d.peer_transport <> 'peer'
         OR d.peer_endpoint_url IS NULL
         OR COALESCE(d.peer_last_seen_at, d.updated_at) < NOW() - ($2 * INTERVAL '1 second')
       )`,
    [userId, PEER_SOURCE_TTL_SECONDS],
  );

  const manifests = await client.query(
    `SELECT id
     FROM raid_manifests
     WHERE user_id = $1 AND status IN ('pending', 'protected', 'degraded', 'repairing')`,
    [userId],
  );

  for (const row of manifests.rows) {
    await reconcileRaidManifest(client, row.id);
    await createRaidRepairJobsForManifest(client, row.id);
  }
}

async function retireRaidManifestsForPath(client, vaultId, itemPath, keepRevision) {
  const manifests = await client.query(
    `SELECT id
     FROM raid_manifests
     WHERE vault_id = $1 AND path = $2 AND revision <> $3 AND status <> 'deleted'`,
    [vaultId, itemPath, keepRevision],
  );
  if (!manifests.rowCount) return;
  const manifestIds = manifests.rows.map((row) => row.id);
  await client.query('UPDATE raid_manifests SET status = $2, updated_at = NOW() WHERE id = ANY($1::uuid[])', [manifestIds, 'superseded']);
  await client.query('UPDATE raid_shard_hosts SET status = $2, updated_at = NOW() WHERE shard_id IN (SELECT id FROM raid_shards WHERE manifest_id = ANY($1::uuid[]))', [manifestIds, 'deleted']);
  await client.query('UPDATE raid_repair_jobs SET status = $2, updated_at = NOW() WHERE manifest_id = ANY($1::uuid[]) AND status IN ($3, $4)', [manifestIds, 'cancelled', 'pending', 'in_progress']);
}

async function chooseRaidAssignmentDevices(client, userId, excludeDeviceIds = []) {
  const devices = await listActivePeerDevices(client, userId, excludeDeviceIds);
  const usageRows = await client.query(
    `SELECT host_device_id, COALESCE(SUM(size_bytes), 0)::BIGINT AS used_bytes
     FROM raid_shard_hosts
     WHERE user_id = $1 AND status IN ('assigned', 'available', 'repairing')
     GROUP BY host_device_id`,
    [userId],
  );
  const usageByDevice = new Map(usageRows.rows.map((row) => [row.host_device_id, Number(row.used_bytes ?? 0)]));
  return devices
    .map((device) => ({ ...device, usedBytes: usageByDevice.get(device.deviceId) ?? 0 }))
    .sort((left, right) => left.usedBytes - right.usedBytes);
}

async function reconcileRaidManifest(client, manifestId) {
  const manifestResult = await client.query(
    `SELECT m.*, v.user_id
     FROM raid_manifests m
     JOIN vaults v ON v.id = m.vault_id
     WHERE m.id = $1`,
    [manifestId],
  );
  if (!manifestResult.rowCount) return null;
  const manifest = manifestResult.rows[0];
  const hostsResult = await client.query(
    `SELECT h.id, h.shard_id, h.host_device_id, h.status, s.shard_index
     FROM raid_shard_hosts h
     JOIN raid_shards s ON s.id = h.shard_id
     WHERE s.manifest_id = $1`,
    [manifestId],
  );
  const activeDevices = await listActivePeerDevices(client, manifest.user_id);
  const activeDeviceIds = new Set(activeDevices.map((row) => row.deviceId));
  const availableShardIndexes = new Set(
    hostsResult.rows
      .filter((row) => row.status === 'available' && activeDeviceIds.has(row.host_device_id))
      .map((row) => Number(row.shard_index)),
  );
  const sourceActive = activeDeviceIds.has(manifest.source_device_id);
  const activeWithSource = new Set(availableShardIndexes);
  if (sourceActive) activeWithSource.add(0);

  let status = 'pending';
  if (availableShardIndexes.size >= RAID_QUORUM_SHARDS) {
    status = 'protected';
  } else if (availableShardIndexes.size > 0 || sourceActive) {
    status = 'degraded';
  }
  await client.query('UPDATE raid_manifests SET status = $2, updated_at = NOW() WHERE id = $1', [manifestId, status]);
  return {
    manifestId,
    status,
    quorumCount: Number(manifest.quorum_count ?? RAID_QUORUM_SHARDS),
    availableShardCount: availableShardIndexes.size,
    activeShardCount: activeWithSource.size,
    sourceActive,
  };
}

async function createRaidRepairJobsForManifest(client, manifestId) {
  const manifestResult = await client.query('SELECT * FROM raid_manifests WHERE id = $1', [manifestId]);
  if (!manifestResult.rowCount) return [];
  const manifest = manifestResult.rows[0];
  if (manifest.status === 'deleted' || manifest.status === 'superseded') return [];

  const reserveUsage = await getRaidReserveUsage(client, manifest.user_id);
  const pkg = await client.query('SELECT raid_reserve_bytes FROM vault_packages WHERE user_id = $1', [manifest.user_id]);
  const reserveLimit = Number(pkg.rows[0]?.raid_reserve_bytes ?? FIVE_GB);
  const candidates = await chooseRaidAssignmentDevices(client, manifest.user_id, [manifest.source_device_id]);
  const shardsResult = await client.query(
    `SELECT id, shard_index, shard_role, size_bytes, sha256
     FROM raid_shards
     WHERE manifest_id = $1 AND shard_index IN (1, 2)
     ORDER BY shard_index ASC`,
    [manifestId],
  );
  const jobs = [];
  let projectedUsage = reserveUsage;
  const activeHostRows = await client.query(
    `SELECT h.host_device_id
     FROM raid_shard_hosts h
     JOIN raid_shards s ON s.id = h.shard_id
     WHERE s.manifest_id = $1
       AND s.shard_index IN (1, 2)
       AND h.status IN ('assigned', 'available', 'repairing')`,
    [manifestId],
  );
  const usedDeviceIds = new Set(activeHostRows.rows.map((row) => row.host_device_id));

  for (const shard of shardsResult.rows) {
    const existing = await client.query(
      `SELECT host_device_id, status
       FROM raid_shard_hosts
       WHERE shard_id = $1 AND status IN ('assigned', 'available', 'repairing')`,
      [shard.id],
    );
    if (existing.rowCount) continue;

    const chosen = candidates.find(
      (candidate) => !usedDeviceIds.has(candidate.deviceId) && candidate.usedBytes + Number(shard.size_bytes) <= candidate.reserveCapacityBytes,
    ) ?? candidates.find((candidate) => candidate.usedBytes + Number(shard.size_bytes) <= candidate.reserveCapacityBytes);
    if (!chosen) continue;
    if (projectedUsage + Number(shard.size_bytes) > reserveLimit) break;
    projectedUsage += Number(shard.size_bytes);
    chosen.usedBytes += Number(shard.size_bytes);
    usedDeviceIds.add(chosen.deviceId);

    const inserted = await client.query(
      `INSERT INTO raid_shard_hosts (shard_id, user_id, host_device_id, endpoint_url, size_bytes, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'assigned', NOW())
       ON CONFLICT (shard_id, host_device_id)
       DO UPDATE SET endpoint_url = EXCLUDED.endpoint_url, size_bytes = EXCLUDED.size_bytes, status = 'assigned', updated_at = NOW()
       RETURNING id`,
      [shard.id, manifest.user_id, chosen.deviceId, chosen.endpointUrl, Number(shard.size_bytes)],
    );
    await client.query(
      `INSERT INTO raid_repair_jobs (manifest_id, shard_id, source_device_id, target_device_id, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [manifestId, shard.id, manifest.source_device_id, chosen.deviceId],
    );
    jobs.push({ shardId: shard.id, hostId: inserted.rows[0].id, targetDeviceId: chosen.deviceId });
  }

  await reconcileRaidManifest(client, manifestId);
  return jobs;
}

async function rebalanceRaidManifest(client, manifestId) {
  const manifestResult = await client.query('SELECT * FROM raid_manifests WHERE id = $1', [manifestId]);
  if (!manifestResult.rowCount) return [];
  const manifest = manifestResult.rows[0];
  if (manifest.status === 'deleted' || manifest.status === 'superseded') return [];

  const shardsResult = await client.query(
    `SELECT id, shard_index, size_bytes
     FROM raid_shards
     WHERE manifest_id = $1 AND shard_index IN (1, 2)
     ORDER BY shard_index ASC`,
    [manifestId],
  );
  if (shardsResult.rowCount < 2) return [];

  const hostsResult = await client.query(
    `SELECT h.shard_id, h.host_device_id, h.status, s.shard_index
     FROM raid_shard_hosts h
     JOIN raid_shards s ON s.id = h.shard_id
     WHERE s.manifest_id = $1 AND h.status IN ('assigned', 'available', 'repairing')`,
    [manifestId],
  );
  const activeDevices = await listActivePeerDevices(client, manifest.user_id, [manifest.source_device_id]);
  const activeDeviceIds = new Set(activeDevices.map((row) => row.deviceId));
  const activeHosts = hostsResult.rows.filter((row) => activeDeviceIds.has(row.host_device_id));
  const reserveHostsByIndex = new Map();
  for (const row of activeHosts) {
    if (!reserveHostsByIndex.has(Number(row.shard_index))) reserveHostsByIndex.set(Number(row.shard_index), []);
    reserveHostsByIndex.get(Number(row.shard_index)).push(row);
  }

  const shardOneHosts = reserveHostsByIndex.get(1) ?? [];
  const shardTwoHosts = reserveHostsByIndex.get(2) ?? [];
  const duplicateDevice = shardOneHosts.find((left) => shardTwoHosts.some((right) => right.host_device_id === left.host_device_id))?.host_device_id;
  if (!duplicateDevice) return [];

  const candidateUsageRows = await client.query(
    `SELECT host_device_id, COALESCE(SUM(size_bytes), 0)::BIGINT AS used_bytes
     FROM raid_shard_hosts
     WHERE user_id = $1 AND status IN ('assigned', 'available', 'repairing')
     GROUP BY host_device_id`,
    [manifest.user_id],
  );
  const usageByDevice = new Map(candidateUsageRows.rows.map((row) => [row.host_device_id, Number(row.used_bytes ?? 0)]));
  const existingByShard = new Map();
  for (const row of hostsResult.rows) {
    if (!existingByShard.has(row.shard_id)) existingByShard.set(row.shard_id, new Set());
    existingByShard.get(row.shard_id).add(row.host_device_id);
  }

  const parityShard = shardsResult.rows.find((row) => Number(row.shard_index) === 2) ?? shardsResult.rows[0];
  const chosen = activeDevices
    .map((device) => ({ ...device, usedBytes: usageByDevice.get(device.deviceId) ?? 0 }))
    .filter((device) => device.deviceId !== duplicateDevice)
    .filter((device) => !(existingByShard.get(parityShard.id)?.has(device.deviceId)))
    .sort((left, right) => left.usedBytes - right.usedBytes)
    .find((device) => device.usedBytes + Number(parityShard.size_bytes) <= device.reserveCapacityBytes);
  if (!chosen) return [];

  const inserted = await client.query(
    `INSERT INTO raid_shard_hosts (shard_id, user_id, host_device_id, endpoint_url, size_bytes, status, updated_at)
     VALUES ($1, $2, $3, $4, $5, 'assigned', NOW())
     ON CONFLICT (shard_id, host_device_id)
     DO UPDATE SET endpoint_url = EXCLUDED.endpoint_url, size_bytes = EXCLUDED.size_bytes, status = 'assigned', updated_at = NOW()
     RETURNING id`,
    [parityShard.id, manifest.user_id, chosen.deviceId, chosen.endpointUrl, Number(parityShard.size_bytes)],
  );
  await client.query(
    `INSERT INTO raid_repair_jobs (manifest_id, shard_id, source_device_id, target_device_id, status)
     VALUES ($1, $2, $3, $4, 'pending')`,
    [manifestId, parityShard.id, manifest.source_device_id, chosen.deviceId],
  );
  return [{ shardId: parityShard.id, hostId: inserted.rows[0].id, targetDeviceId: chosen.deviceId, reason: 'rebalance_duplicate_host' }];
}

async function runRaidMaintenanceForUser(client, userId) {
  await refreshRaidHealthForUser(client, userId);
  const manifests = await client.query(
    `SELECT id
     FROM raid_manifests
     WHERE user_id = $1 AND status IN ('pending', 'protected', 'degraded', 'repairing')`,
    [userId],
  );
  const jobs = [];
  for (const row of manifests.rows) {
    jobs.push(...await createRaidRepairJobsForManifest(client, row.id));
    jobs.push(...await rebalanceRaidManifest(client, row.id));
    await reconcileRaidManifest(client, row.id);
  }
  return { checkedManifests: manifests.rowCount, queuedJobs: jobs.length, jobs };
}

async function buildRaidStatusForUser(client, userId, targetDeviceId) {
  const manifests = await client.query(
    `SELECT id, vault_id, path, revision, status
     FROM raid_manifests
     WHERE user_id = $1 AND status IN ('pending', 'protected', 'degraded', 'repairing')
     ORDER BY updated_at DESC
     LIMIT 100`,
    [userId],
  );
  const summaries = [];
  for (const row of manifests.rows) {
    const summary = await getRaidManifestSummary(userId, row.vault_id, row.path, Number(row.revision), targetDeviceId);
    if (summary) summaries.push(summary);
  }
  const reserve = await client.query('SELECT raid_reserve_bytes FROM vault_packages WHERE user_id = $1', [userId]);
  const reserveUsage = await getRaidReserveUsage(client, userId);
  const activePeers = await listActivePeerDevices(client, userId);
  const jobs = await client.query(
    `SELECT status, COUNT(*)::INT AS count
     FROM raid_repair_jobs
     WHERE manifest_id IN (SELECT id FROM raid_manifests WHERE user_id = $1)
     GROUP BY status`,
    [userId],
  );
  const repairJobs = Object.fromEntries(jobs.rows.map((row) => [row.status, Number(row.count)]));
  return {
    reserveBytes: Number(reserve.rows[0]?.raid_reserve_bytes ?? FIVE_GB),
    reserveUsedBytes: reserveUsage,
    activeReservePeers: activePeers.length,
    summary: {
      total: summaries.length,
      protected: summaries.filter((item) => item.status === 'protected').length,
      degraded: summaries.filter((item) => item.status === 'degraded').length,
      pending: summaries.filter((item) => item.status === 'pending' || item.status === 'repairing').length,
    },
    repairJobs,
    manifests: summaries,
  };
}

async function getRaidManifestSummary(userId, vaultId, itemPath, revision, targetDeviceId) {
  const manifestResult = await pool.query(
    `SELECT id, root_kind, revision, size_bytes, shard_bytes, status, quorum_count, source_device_id
     FROM raid_manifests
     WHERE user_id = $1 AND vault_id = $2 AND path = $3 AND revision = $4 AND status <> 'deleted'
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, vaultId, itemPath, revision],
  );
  if (!manifestResult.rowCount) return null;
  const manifest = manifestResult.rows[0];
  const shardsResult = await pool.query(
    `SELECT s.id, s.shard_index, s.shard_role, s.size_bytes, s.sha256,
            h.host_device_id, h.endpoint_url, h.status
     FROM raid_shards s
     LEFT JOIN raid_shard_hosts h ON h.shard_id = s.id AND h.status IN ('assigned', 'available', 'repairing')
     WHERE s.manifest_id = $1
     ORDER BY s.shard_index ASC`,
    [manifest.id],
  );
  const grouped = new Map();
  for (const row of shardsResult.rows) {
    if (!grouped.has(row.shard_index)) {
      grouped.set(row.shard_index, {
        shard_id: row.id,
        shard_index: Number(row.shard_index),
        shard_role: row.shard_role,
        size_bytes: Number(row.size_bytes ?? 0),
        sha256: row.sha256,
        sources: [],
      });
    }
    if (row.endpoint_url && row.status === 'available') {
      grouped.get(row.shard_index).sources.push({
        device_id: row.host_device_id,
        endpoint_url: row.endpoint_url,
        ticket: signPeerTicket({
          kind: 'raid_hosted_shard',
          userId,
          sourceDeviceId: row.host_device_id,
          targetDeviceId,
          manifestId: manifest.id,
          shardId: row.id,
          shardIndex: Number(row.shard_index),
          rootKind: manifest.root_kind,
          path: itemPath,
          expiresAt: Date.now() + 5 * 60 * 1000,
        }),
      });
    }
  }
  return {
    manifest_id: manifest.id,
    path: itemPath,
    root_kind: manifest.root_kind,
    revision: Number(manifest.revision),
    size_bytes: Number(manifest.size_bytes ?? 0),
    shard_bytes: Number(manifest.shard_bytes ?? 0),
    status: manifest.status,
    quorum_count: Number(manifest.quorum_count ?? RAID_QUORUM_SHARDS),
    source_device_id: manifest.source_device_id,
    shards: Array.from(grouped.values()),
  };
}

async function getUserSecurity(client, userId, password) {
  const existing = await client.query('SELECT password_hash, salt FROM user_security WHERE user_id = $1', [userId]);
  if (existing.rowCount) return existing.rows[0];

  const passwordHash = await hashPassword(password);
  const salt = crypto.randomBytes(16);
  const created = await client.query(
    'INSERT INTO user_security (user_id, password_hash, salt) VALUES ($1, $2, $3) RETURNING password_hash, salt',
    [userId, passwordHash, salt],
  );
  return created.rows[0];
}

async function createWrappedDekForVault(client, userId, password, vaultId, vaultType) {
  const security = await getUserSecurity(client, userId, password);
  const kek = await deriveKek(password, security.salt);
  const dek = generateDek();
  const wrapped = wrapDek(kek, dek);

  await client.query(
    `INSERT INTO vault_keys (vault_id, key_version, wrapped_dek, wrap_iv, wrap_tag)
     VALUES ($1, 1, $2, $3, $4)
     ON CONFLICT (vault_id, key_version) DO NOTHING`,
    [vaultId, wrapped.ciphertext, wrapped.iv, wrapped.tag],
  );

  const serverWrapped = wrapDek(serverKek(), dek);
  await client.query(
    `INSERT INTO vault_server_keys (vault_id, key_version, wrapped_dek, wrap_iv, wrap_tag)
     VALUES ($1, 1, $2, $3, $4)
     ON CONFLICT (vault_id) DO NOTHING`,
    [vaultId, serverWrapped.ciphertext, serverWrapped.iv, serverWrapped.tag],
  );
}

async function createPackageForUser(client, userId) {
  await client.query(
    `INSERT INTO vault_packages (user_id, total_quota_bytes, user_quota_bytes, raid_reserve_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, TEN_GB, FIVE_GB, FIVE_GB],
  );
}

async function createDefaultVaultsForUser(client, userId, password) {
  await createPackageForUser(client, userId);
  const result = await client.query(
    `INSERT INTO vaults (user_id, type, name)
     VALUES ($1, 'user_vault', 'User Vault'), ($1, 'share_vault', 'Share Vault')
     ON CONFLICT (user_id, type) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, type`,
    [userId],
  );

  for (const row of result.rows) {
    await createWrappedDekForVault(client, userId, password, row.id, row.type);
  }
}

async function ensureDefaultAdmin() {
  const email = process.env.DEFAULT_ADMIN_EMAIL;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await pool.query('SELECT id FROM app_users WHERE email = $1', [email]);
  if (existing.rowCount) {
    await pool.query('UPDATE app_users SET role = $2 WHERE id = $1', [existing.rows[0].id, 'admin']);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query(
      'INSERT INTO app_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id',
      [email, 'stored-in-user-security', 'admin'],
    );
    await createDefaultVaultsForUser(client, created.rows[0].id, password);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getOwnedVault(vaultId, userId) {
  const result = await pool.query('SELECT id, user_id, type, name FROM vaults WHERE id = $1 AND user_id = $2', [vaultId, userId]);
  return result.rows[0] ?? null;
}

async function resolveVaultDek(userId, vaultId, password) {
  const security = await pool.query('SELECT salt FROM user_security WHERE user_id = $1', [userId]);
  const wrapped = await pool.query(
    'SELECT wrapped_dek, wrap_iv, wrap_tag FROM vault_keys WHERE vault_id = $1 AND key_version = 1',
    [vaultId],
  );
  if (!security.rowCount || !wrapped.rowCount) throw new Error('Missing key material');

  const kek = await deriveKek(password, security.rows[0].salt);
  return unwrapDek(kek, wrapped.rows[0].wrapped_dek, wrapped.rows[0].wrap_iv, wrapped.rows[0].wrap_tag);
}

async function ensureServerWrappedVaultKey(vault, ownerPassword) {
  const exists = await pool.query('SELECT 1 FROM vault_server_keys WHERE vault_id = $1', [vault.id]);
  if (exists.rowCount) return;

  const dek = await resolveVaultDek(vault.user_id, vault.id, ownerPassword);
  const wrapped = wrapDek(serverKek(), dek);
  await pool.query(
    `INSERT INTO vault_server_keys (vault_id, key_version, wrapped_dek, wrap_iv, wrap_tag)
     VALUES ($1, 1, $2, $3, $4)
     ON CONFLICT (vault_id) DO NOTHING`,
    [vault.id, wrapped.ciphertext, wrapped.iv, wrapped.tag],
  );
}

async function resolveShareDek(vaultId) {
  const wrapped = await pool.query(
    'SELECT wrapped_dek, wrap_iv, wrap_tag FROM vault_server_keys WHERE vault_id = $1 AND key_version = 1',
    [vaultId],
  );
  if (!wrapped.rowCount) throw new Error('Shared key material missing');
  return unwrapDek(serverKek(), wrapped.rows[0].wrapped_dek, wrapped.rows[0].wrap_iv, wrapped.rows[0].wrap_tag);
}

async function getPackageAndUsage(userId) {
  await pool.query(
    `INSERT INTO vault_packages (user_id, total_quota_bytes, user_quota_bytes, raid_reserve_bytes)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, TEN_GB, FIVE_GB, FIVE_GB],
  );

  const pkg = await pool.query('SELECT * FROM vault_packages WHERE user_id = $1', [userId]);
  const usage = await pool.query(
    `SELECT COALESCE(SUM(i.size_bytes), 0)::BIGINT AS used_bytes
     FROM vault_items i
     JOIN vaults v ON v.id = i.vault_id
     WHERE v.user_id = $1 AND i.item_type = 'file'`,
    [userId],
  );
  return { package: pkg.rows[0], usedBytes: Number(usage.rows[0].used_bytes) };
}

async function publishPeerSource(client, { userId, vault, deviceId, rootKind, relativePath, revision, sizeBytes, sha256, pieces = [] }) {
  const normalizedDeviceId = sanitizeDeviceId(deviceId);
  const normalizedPath = normalizeRelativePath(relativePath);
  await client.query(
    `INSERT INTO sync_peer_sources (user_id, vault_id, device_id, root_kind, path, revision, size_bytes, sha256)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (vault_id, path, device_id)
     DO UPDATE SET
       root_kind = EXCLUDED.root_kind,
       revision = EXCLUDED.revision,
       size_bytes = EXCLUDED.size_bytes,
       sha256 = EXCLUDED.sha256,
       updated_at = NOW()`,
    [userId, vault.id, normalizedDeviceId, rootKind, normalizedPath, revision, sizeBytes, sha256],
  );
  if (Array.isArray(pieces) && pieces.length) {
    await client.query(
      'DELETE FROM sync_peer_pieces WHERE user_id = $1 AND vault_id = $2 AND device_id = $3 AND path = $4 AND revision <> $5',
      [userId, vault.id, normalizedDeviceId, normalizedPath, revision],
    );
    for (const piece of pieces.slice(0, 20000)) {
      await client.query(
        `INSERT INTO sync_peer_pieces (
           user_id, vault_id, device_id, root_kind, path, revision, piece_index,
           piece_size_bytes, offset_bytes, size_bytes, sha256
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (vault_id, path, revision, device_id, piece_index)
         DO UPDATE SET
           root_kind = EXCLUDED.root_kind,
           piece_size_bytes = EXCLUDED.piece_size_bytes,
           offset_bytes = EXCLUDED.offset_bytes,
           size_bytes = EXCLUDED.size_bytes,
           sha256 = EXCLUDED.sha256,
           updated_at = NOW()`,
        [
          userId,
          vault.id,
          normalizedDeviceId,
          rootKind,
          normalizedPath,
          revision,
          Number(piece.index ?? piece.pieceIndex ?? 0),
          Number(piece.pieceSizeBytes ?? 0),
          Number(piece.offsetBytes ?? 0),
          Number(piece.sizeBytes ?? 0),
          piece.sha256,
        ],
      );
    }
  }
}

async function unpublishPeerSource(client, { userId, vault, deviceId, relativePath }) {
  const normalizedDeviceId = sanitizeDeviceId(deviceId);
  const normalizedPath = normalizeRelativePath(relativePath);
  await client.query(
    'DELETE FROM sync_peer_sources WHERE user_id = $1 AND vault_id = $2 AND device_id = $3 AND path = $4',
    [userId, vault.id, normalizedDeviceId, normalizedPath],
  );
  await client.query(
    'DELETE FROM sync_peer_pieces WHERE user_id = $1 AND vault_id = $2 AND device_id = $3 AND path = $4',
    [userId, vault.id, normalizedDeviceId, normalizedPath],
  );
}

async function registerRaidManifest(client, { userId, vault, fileId, rootKind, relativePath, revision, sizeBytes, sha256, shardBytes, shards, deviceId }) {
  if (!isRaidEligibleRoot(rootKind)) return null;
  await retireRaidManifestsForPath(client, vault.id, relativePath, revision);
  const inserted = await client.query(
    `INSERT INTO raid_manifests (
       user_id, vault_id, file_id, root_kind, path, revision, size_bytes, shard_bytes,
       content_sha256, source_device_id, data_shard_count, parity_shard_count, quorum_count, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'pending')
     ON CONFLICT (vault_id, path, revision)
     DO UPDATE SET
       file_id = EXCLUDED.file_id,
       size_bytes = EXCLUDED.size_bytes,
       shard_bytes = EXCLUDED.shard_bytes,
       content_sha256 = EXCLUDED.content_sha256,
       source_device_id = EXCLUDED.source_device_id,
       status = 'pending',
       updated_at = NOW()
     RETURNING id, revision, status`,
    [userId, vault.id, fileId, rootKind, relativePath, revision, sizeBytes, shardBytes, sha256, sanitizeDeviceId(deviceId), RAID_DATA_SHARDS, RAID_PARITY_SHARDS, RAID_QUORUM_SHARDS],
  );
  const manifestId = inserted.rows[0].id;
  await client.query('DELETE FROM raid_shards WHERE manifest_id = $1', [manifestId]);
  for (const shard of shards) {
    await client.query(
      `INSERT INTO raid_shards (manifest_id, shard_index, shard_role, size_bytes, sha256)
       VALUES ($1, $2, $3, $4, $5)`,
      [manifestId, shard.index, shard.role, shard.sizeBytes, shard.sha256],
    );
  }
  await createRaidRepairJobsForManifest(client, manifestId);
  return { manifestId, revision };
}

async function deleteRaidMetadataForPath(client, vaultId, itemPath) {
  await client.query(
    `UPDATE raid_manifests
     SET status = 'deleted', updated_at = NOW()
     WHERE vault_id = $1 AND (path = $2 OR path LIKE $3)`,
    [vaultId, itemPath, `${itemPath}/%`],
  );
  await client.query(
    `UPDATE raid_shard_hosts
     SET status = 'deleted', updated_at = NOW()
     WHERE shard_id IN (
       SELECT s.id
       FROM raid_shards s
       JOIN raid_manifests m ON m.id = s.manifest_id
       WHERE m.vault_id = $1 AND (m.path = $2 OR m.path LIKE $3)
     )`,
    [vaultId, itemPath, `${itemPath}/%`],
  );
}

async function saveSystemUpdateRecord(payload) {
  await pool.query(
    `INSERT INTO system_update_jobs (status, local_sha, remote_sha, message, logs)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      payload.status ?? 'unknown',
      payload.localSha ?? null,
      payload.remoteSha ?? null,
      payload.message ?? null,
      payload.logs ? String(payload.logs).slice(-20000) : null,
    ],
  );
}

async function callUpdater(path, options = {}) {
  const response = await fetch(`${UPDATER_URL}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? 'Updater request failed');
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function callBackup(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.body && !headers['content-type']) headers['content-type'] = 'application/json';
  const response = await fetch(`${BACKUP_URL}${path}`, {
    ...options,
    headers,
  });
  if (options.responseType === 'arrayBuffer') {
    const body = await response.arrayBuffer();
    if (!response.ok) {
      let parsed = null;
      try {
        parsed = JSON.parse(Buffer.from(body).toString('utf8'));
      } catch {
        parsed = null;
      }
      const error = new Error(parsed?.error ?? 'Backup request failed');
      error.status = response.status;
      error.body = parsed;
      throw error;
    }
    return {
      body: Buffer.from(body),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      contentDisposition: response.headers.get('content-disposition') ?? null,
    };
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error ?? 'Backup request failed');
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { email, password, role = 'user' } = parsed.data;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const user = await client.query(
      'INSERT INTO app_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at',
      [email, 'stored-in-user-security', role],
    );
    await createDefaultVaultsForUser(client, user.rows[0].id, password);
    await client.query('COMMIT');
    return res.status(201).json({ user: user.rows[0], token: signToken(user.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

app.post('/api/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const user = await pool.query('SELECT id, email, role FROM app_users WHERE email = $1', [parsed.data.email]);
  if (!user.rowCount) return res.status(401).json({ error: 'Invalid credentials' });

  const security = await pool.query('SELECT password_hash FROM user_security WHERE user_id = $1', [user.rows[0].id]);
  if (!security.rowCount || !(await verifyPassword(security.rows[0].password_hash, parsed.data.password))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  return res.json({ token: signToken(user.rows[0]), user: user.rows[0] });
});

app.post('/api/auth/change-password', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (parsed.data.currentPassword === parsed.data.newPassword) {
    return res.status(400).json({ error: 'New password must be different from current password' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const security = await client.query('SELECT password_hash, salt FROM user_security WHERE user_id = $1 FOR UPDATE', [req.user.sub]);
    if (!security.rowCount || !(await verifyPassword(security.rows[0].password_hash, parsed.data.currentPassword))) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    const vaults = await client.query('SELECT id, user_id, type, name FROM vaults WHERE user_id = $1', [req.user.sub]);
    for (const vault of vaults.rows) {
      await ensureServerWrappedVaultKey(vault, parsed.data.currentPassword);
    }

    const currentKek = await deriveKek(parsed.data.currentPassword, security.rows[0].salt);
    const nextSalt = crypto.randomBytes(16);
    const nextPasswordHash = await hashPassword(parsed.data.newPassword);
    const nextKek = await deriveKek(parsed.data.newPassword, nextSalt);

    const keys = await client.query(
      `SELECT vk.vault_id, vk.wrapped_dek, vk.wrap_iv, vk.wrap_tag
       FROM vault_keys vk
       JOIN vaults v ON v.id = vk.vault_id
       WHERE v.user_id = $1 AND vk.key_version = 1
       FOR UPDATE`,
      [req.user.sub],
    );

    for (const row of keys.rows) {
      const dek = unwrapDek(currentKek, row.wrapped_dek, row.wrap_iv, row.wrap_tag);
      const rewrapped = wrapDek(nextKek, dek);
      await client.query(
        `UPDATE vault_keys
         SET wrapped_dek = $2, wrap_iv = $3, wrap_tag = $4
         WHERE vault_id = $1 AND key_version = 1`,
        [row.vault_id, rewrapped.ciphertext, rewrapped.iv, rewrapped.tag],
      );
    }

    await client.query(
      `UPDATE user_security
       SET password_hash = $2, salt = $3
       WHERE user_id = $1`,
      [req.user.sub, nextPasswordHash, nextSalt],
    );
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to change password' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/users/:userId/reset-password', authenticate, authorize('admin'), async (req, res) => {
  const parsed = adminResetPasswordSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const security = await client.query('SELECT password_hash FROM user_security WHERE user_id = $1 FOR UPDATE', [req.params.userId]);
    if (!security.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'User security record not found' });
    }

    const keys = await client.query(
      `SELECT vk.vault_id, v.type, sk.wrapped_dek, sk.wrap_iv, sk.wrap_tag
       FROM vaults v
       JOIN vault_server_keys sk ON sk.vault_id = v.id AND sk.key_version = 1
       JOIN vault_keys vk ON vk.vault_id = v.id AND vk.key_version = 1
       WHERE v.user_id = $1
       FOR UPDATE`,
      [req.params.userId],
    );
    if (!keys.rowCount) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Vault recovery key not available for this user yet' });
    }

    const nextSalt = crypto.randomBytes(16);
    const nextPasswordHash = await hashPassword(parsed.data.newPassword);
    const nextKek = await deriveKek(parsed.data.newPassword, nextSalt);

    for (const row of keys.rows) {
      const dek = unwrapDek(serverKek(), row.wrapped_dek, row.wrap_iv, row.wrap_tag);
      const rewrapped = wrapDek(nextKek, dek);
      await client.query(
        `UPDATE vault_keys
         SET wrapped_dek = $2, wrap_iv = $3, wrap_tag = $4
         WHERE vault_id = $1 AND key_version = 1`,
        [row.vault_id, rewrapped.ciphertext, rewrapped.iv, rewrapped.tag],
      );
    }

    await client.query(
      `UPDATE user_security
       SET password_hash = $2, salt = $3
       WHERE user_id = $1`,
      [req.params.userId, nextPasswordHash, nextSalt],
    );
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to reset user password' });
  } finally {
    client.release();
  }
});

app.get('/api/me', authenticate, async (req, res) => {
  const user = await pool.query('SELECT id, email, role, created_at FROM app_users WHERE id = $1', [req.user.sub]);
  const quota = await getPackageAndUsage(req.user.sub);
  res.json({ user: user.rows[0], quota });
});

app.get('/api/vaults', authenticate, authorize('user', 'admin'), async (req, res) => {
  const vaults = await pool.query(
    `SELECT v.id, v.user_id, v.type, v.name, v.created_at, COALESCE(SUM(i.size_bytes), 0)::BIGINT AS used_bytes
     FROM vaults v
     LEFT JOIN vault_items i ON i.vault_id = v.id AND i.item_type = 'file'
     WHERE v.user_id = $1
     GROUP BY v.id
     ORDER BY v.created_at ASC`,
    [req.user.sub],
  );
  const quota = await getPackageAndUsage(req.user.sub);
  res.json({ vaults: vaults.rows, quota });
});

app.post('/api/vaults', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = createVaultSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const name = parsed.data.name ?? (parsed.data.type === 'user_vault' ? 'User Vault' : 'Share Vault');
  const vault = await pool.query(
    `INSERT INTO vaults (user_id, type, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, type) DO UPDATE SET name = EXCLUDED.name
     RETURNING id, user_id, type, name, created_at`,
    [req.user.sub, parsed.data.type, name],
  );
  res.status(201).json({ vault: vault.rows[0] });
});

app.get('/api/files', authenticate, authorize('user', 'admin'), async (req, res) => {
  const vaultId = String(req.query.vaultId ?? '');
  const path = normalizeDirPath(req.query.path ?? '/');
  const vault = await getOwnedVault(vaultId, req.user.sub);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const items = await pool.query(
    `SELECT id, vault_id, parent_path, path, name, item_type, mime_type, size_bytes, revision, content_sha256, created_at, updated_at
     FROM vault_items
     WHERE vault_id = $1 AND parent_path = $2
     ORDER BY item_type DESC, name ASC`,
    [vaultId, path],
  );
  res.json({ vault, path, items: items.rows });
});

app.post('/api/files/folder', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = folderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const vault = await getOwnedVault(parsed.data.vaultId, req.user.sub);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const parentPath = normalizeDirPath(parsed.data.path);
  const name = normalizeItemName(parsed.data.name);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const folder = await createFolderEntry(client, { userId: req.user.sub, vault, parentPath, name });
    await client.query('COMMIT');
    return res.status(201).json({ item: folder });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.status === 409) return res.status(409).json({ error: error.message });
    console.error(error);
    return res.status(500).json({ error: 'Failed to create folder' });
  } finally {
    client.release();
  }
});

app.post(
  '/api/files/upload',
  authenticate,
  authorize('user', 'admin'),
  express.raw({ type: '*/*', limit: FILE_UPLOAD_LIMIT }),
  async (req, res) => {
    if (isPeerMode()) {
      return res.status(409).json({ error: 'Desktop peer mode is enabled. Upload files from the Windows desktop client.' });
    }
    const vaultId = String(req.query.vaultId ?? '');
    const parentPath = normalizeDirPath(req.query.path ?? '/');
    const password = req.headers['x-vault-password'];
    const fileName = req.headers['x-file-name'];
    if (!vaultId || typeof password !== 'string' || typeof fileName !== 'string') {
      return res.status(400).json({ error: 'vaultId, x-file-name, and x-vault-password required' });
    }

    let name;
    try {
      name = normalizeItemName(decodeURIComponent(fileName));
    } catch {
      return res.status(400).json({ error: 'Invalid file name' });
    }

    const vault = await getOwnedVault(vaultId, req.user.sub);
    if (!vault) return res.status(404).json({ error: 'Vault not found' });

    const plaintext = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
    const quota = await getPackageAndUsage(req.user.sub);
    const itemPath = joinVaultPath(parentPath, name);
    const existingSize = await pool.query(
      `SELECT size_bytes
       FROM vault_items
       WHERE vault_id = $1 AND path = $2 AND item_type = 'file'`,
      [vault.id, itemPath],
    );
    const projectedUsedBytes = quota.usedBytes - Number(existingSize.rows[0]?.size_bytes ?? 0) + plaintext.length;
    if (projectedUsedBytes > Number(quota.package.user_quota_bytes)) {
      return res.status(413).json({ error: '5GB user quota exceeded', quota });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const uploaded = await upsertFileEntry(client, {
        userId: req.user.sub,
        vault,
        parentPath,
        name,
        plaintext,
        mimeType: req.headers['content-type'] ?? 'application/octet-stream',
        password,
      });
      await client.query('COMMIT');
      for (const objectKey of uploaded.oldObjectKeys) {
        await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
      }
      return res.status(201).json({ item: uploaded.item, quota: await getPackageAndUsage(req.user.sub) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error.status === 409) return res.status(409).json({ error: error.message });
      console.error(error);
      return res.status(500).json({ error: 'Failed to upload file' });
    } finally {
      client.release();
    }
  },
);

app.get('/api/files/:fileId/download', authenticate, authorize('user', 'admin'), async (req, res) => {
  const password = req.headers['x-vault-password'];
  if (typeof password !== 'string') return res.status(400).json({ error: 'x-vault-password required' });

  const item = await pool.query(
    `SELECT i.id, i.vault_id, i.name, i.mime_type, i.path, i.storage_backend, v.user_id
     FROM vault_items i
     JOIN vaults v ON v.id = i.vault_id
     WHERE i.id = $1 AND i.item_type = 'file' AND v.user_id = $2`,
    [req.params.fileId, req.user.sub],
  );
  if (!item.rowCount) return res.status(404).json({ error: 'File not found' });
  if (item.rows[0].storage_backend === 'peer') {
    const sources = await listPeerSourcesForPath(req.user.sub, item.rows[0].vault_id, item.rows[0].path, null, null);
    return res.status(409).json({ error: 'File is stored in desktop peer mode. Use the desktop client to download it.', peerSources: sources });
  }

  const dek = await resolveVaultDek(req.user.sub, item.rows[0].vault_id, password);
  const chunks = await pool.query('SELECT * FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index ASC', [item.rows[0].id]);
  const plaintext = [];
  for (const chunk of chunks.rows) {
    const stream = await minioClient.getObject(getBucketName(), chunk.object_key);
    const encrypted = [];
    for await (const part of stream) encrypted.push(part);
    plaintext.push(decryptChunk(dek, Buffer.concat(encrypted), chunk.enc_iv, chunk.enc_tag));
  }

  res.setHeader('Content-Type', item.rows[0].mime_type ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${contentDispositionName(item.rows[0].name)}"`);
  res.send(Buffer.concat(plaintext));
});

app.delete('/api/files/:fileId', authenticate, authorize('user', 'admin'), async (req, res) => {
  const item = await pool.query(
    `SELECT i.id, i.vault_id, i.path, i.item_type
     FROM vault_items i
     JOIN vaults v ON v.id = i.vault_id
     WHERE i.id = $1 AND v.user_id = $2`,
    [req.params.fileId, req.user.sub],
  );
  if (!item.rowCount) return res.status(404).json({ error: 'Item not found' });

  const target = item.rows[0];
  const vault = await getOwnedVault(target.vault_id, req.user.sub);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM sync_peer_sources WHERE vault_id = $1 AND (path = $2 OR path LIKE $3)', [target.vault_id, target.path, `${target.path}/%`]);
    await client.query('DELETE FROM sync_peer_pieces WHERE vault_id = $1 AND (path = $2 OR path LIKE $3)', [target.vault_id, target.path, `${target.path}/%`]);
    await deleteRaidMetadataForPath(client, target.vault_id, target.path);
    const deleted = await deleteVaultPath(client, { userId: req.user.sub, vault, itemPath: target.path });
    await client.query('COMMIT');
    for (const objectKey of deleted.objectKeys) {
      await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
    }
    res.json({ ok: true, deleted: deleted.deleted });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    res.status(error.status ?? 500).json({ error: error.message ?? 'Failed to delete item' });
  } finally {
    client.release();
  }
});

app.get('/api/share/files', authenticate, authorize('user', 'admin'), async (req, res) => {
  const path = normalizeDirPath(req.query.path ?? '/');
  const items = await pool.query(
    `SELECT i.id, i.vault_id, i.parent_path, i.path, i.name, i.item_type, i.mime_type, i.size_bytes,
            i.revision, i.content_sha256, i.created_at, i.updated_at, u.email AS owner_email
     FROM vault_items i
     JOIN vaults v ON v.id = i.vault_id
     JOIN app_users u ON u.id = v.user_id
     WHERE v.type = 'share_vault' AND i.parent_path = $1
     ORDER BY i.item_type DESC, i.name ASC`,
    [path],
  );
  res.json({ path, items: items.rows });
});

app.get('/api/share/files/:fileId/download', authenticate, authorize('user', 'admin'), async (req, res) => {
  const item = await pool.query(
    `SELECT i.id, i.vault_id, i.name, i.mime_type, i.path, i.storage_backend, v.user_id
     FROM vault_items i
     JOIN vaults v ON v.id = i.vault_id
     WHERE i.id = $1 AND i.item_type = 'file' AND v.type = 'share_vault'`,
    [req.params.fileId],
  );
  if (!item.rowCount) return res.status(404).json({ error: 'Shared file not found' });
  if (item.rows[0].storage_backend === 'peer') {
    const sources = await listPeerSourcesForPath(item.rows[0].user_id, item.rows[0].vault_id, item.rows[0].path, null, null);
    return res.status(409).json({ error: 'Shared file is stored in desktop peer mode. Use the desktop client to download it.', peerSources: sources });
  }

  const dek = await resolveShareDek(item.rows[0].vault_id);
  const chunks = await pool.query('SELECT * FROM file_chunks WHERE file_id = $1 ORDER BY chunk_index ASC', [item.rows[0].id]);
  const plaintext = [];
  for (const chunk of chunks.rows) {
    const stream = await minioClient.getObject(getBucketName(), chunk.object_key);
    const encrypted = [];
    for await (const part of stream) encrypted.push(part);
    plaintext.push(decryptChunk(dek, Buffer.concat(encrypted), chunk.enc_iv, chunk.enc_tag));
  }

  res.setHeader('Content-Type', item.rows[0].mime_type ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${contentDispositionName(item.rows[0].name)}"`);
  res.send(Buffer.concat(plaintext));
});

app.get('/api/client/config', authenticate, authorize('user', 'admin'), async (req, res) => {
  const vaults = await pool.query('SELECT id, type, name FROM vaults WHERE user_id = $1 ORDER BY created_at ASC', [req.user.sub]);
  const quota = await getPackageAndUsage(req.user.sub);
  res.json({
    apiBaseUrl: getPublicAppUrl(req),
    userId: req.user.sub,
    vaults: vaults.rows,
    quota,
    sync: {
      userDriveName: 'User Vault',
      shareDriveName: 'Share Vault',
      shareFolderName: 'Share Folder',
      encryption: 'AES-256-GCM',
      chunkSizeBytes: 1024 * 1024,
      transportMode: SYNC_TRANSPORT_MODE,
      peerPort: PEER_DEFAULT_PORT,
      torrentSync: isPeerMode() ? 'desktop-peer' : 'server-relay',
    },
    desktopUpdater: {
      provider: 'github-releases',
      repo: DESKTOP_RELEASE_REPO,
      currentVersion: DESKTOP_CURRENT_VERSION,
      latestUrl: DESKTOP_RELEASE_URL,
    },
  });
});

app.get('/api/client/downloads', authenticate, authorize('user', 'admin'), (_req, res) => {
  res.json({
    downloads: [
      {
        platform: 'windows',
        status: 'beta',
        label: 'Windows Vault Client',
        version: DESKTOP_CURRENT_VERSION,
        url: DESKTOP_RELEASE_URL,
        provider: 'github-releases',
        repo: DESKTOP_RELEASE_REPO,
      },
      { platform: 'android', status: 'planned', label: 'Android Vault Client', url: null },
    ],
  });
});

app.get('/api/sync/bootstrap', authenticate, authorize('user', 'admin'), async (req, res) => {
  const deviceId = sanitizeDeviceId(req.query.deviceId);
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await refreshRaidHealthForUser(client, req.user.sub);
    const device = await ensureSyncDevice(client, req.user.sub, {
      deviceId,
      deviceName: req.query.deviceName,
      platform: req.query.platform,
    });
    const vaults = await client.query(
      'SELECT id, type, name FROM vaults WHERE user_id = $1 AND type IN ($2, $3) ORDER BY created_at ASC',
      [req.user.sub, 'user_vault', 'share_vault'],
    );
    const cursorResult = await client.query('SELECT COALESCE(MAX(cursor), 0)::BIGINT AS cursor FROM sync_changes WHERE user_id = $1', [req.user.sub]);
    await client.query('COMMIT');
    return res.json({
      device: serializeSyncDevice(device),
      cursor: Number(cursorResult.rows[0].cursor),
      apiBaseUrl: getPublicAppUrl(req),
      transportMode: SYNC_TRANSPORT_MODE,
      peer: {
        enabled: isPeerMode(),
        defaultPort: PEER_DEFAULT_PORT,
        sourceTtlSeconds: PEER_SOURCE_TTL_SECONDS,
      },
      raid: {
        enabled: isPeerMode(),
        dataShards: RAID_DATA_SHARDS,
        parityShards: RAID_PARITY_SHARDS,
        quorumShards: RAID_QUORUM_SHARDS,
        reserveBytes: FIVE_GB,
      },
      vaults: vaults.rows,
      localRoots: {
        user_vault: rootLabelForVaultType('user_vault'),
        share_vault: rootLabelForVaultType('share_vault'),
      },
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to bootstrap sync device' });
  } finally {
    client.release();
  }
});

app.get('/api/sync/changes', authenticate, authorize('user', 'admin'), async (req, res) => {
  const cursor = Number(req.query.cursor ?? 0);
  if (!Number.isFinite(cursor) || cursor < 0) return res.status(400).json({ error: 'Invalid cursor' });
  const deviceId = sanitizeDeviceId(req.query.deviceId);
  if (isPeerMode()) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await refreshRaidHealthForUser(client, req.user.sub);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(error);
    } finally {
      client.release();
    }
  }
  const changes = await listSyncChangesForUser(req.user.sub, cursor, deviceId || null);
  const serialized = await Promise.all(changes.map((row) => serializeSyncChangeForUser(row, req.user.sub, deviceId || null)));
  res.json({ cursor, transportMode: SYNC_TRANSPORT_MODE, changes: serialized, hasMore: changes.length >= SYNC_PAGE_SIZE });
});

app.post('/api/sync/peer/register', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncPeerRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const device = await ensureSyncDevice(client, req.user.sub, {
      deviceId: parsed.data.deviceId,
      deviceName: req.query.deviceName,
      platform: req.query.platform,
      localRoots: parsed.data.localRoots ?? {},
      peerEndpointUrl: parsed.data.endpointUrl,
      peerPort: parsed.data.peerPort ?? PEER_DEFAULT_PORT,
      peerTransport: SYNC_TRANSPORT_MODE,
      reserveCapacityBytes: parsed.data.reserveCapacityBytes ?? FIVE_GB,
      reserveEnabled: parsed.data.reserveEnabled ?? true,
    });
    await refreshRaidHealthForUser(client, req.user.sub);
    await client.query('COMMIT');
    return res.json({ ok: true, transportMode: SYNC_TRANSPORT_MODE, device: serializeSyncDevice(device) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to register desktop peer endpoint' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/peer/availability', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncPeerAvailabilitySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const vault = await getOwnedVaultByType(req.user.sub, parsed.data.rootKind);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId: parsed.data.deviceId });
    if (parsed.data.present === false) {
      await unpublishPeerSource(client, {
        userId: req.user.sub,
        vault,
        deviceId: parsed.data.deviceId,
        relativePath: parsed.data.relativePath,
      });
    } else {
      const version = parsed.data.revision
        ? { revision: parsed.data.revision }
        : await client
            .query('SELECT revision FROM sync_file_versions WHERE vault_id = $1 AND path = $2', [vault.id, normalizeRelativePath(parsed.data.relativePath)])
            .then((result) => ({ revision: Number(result.rows[0]?.revision ?? 0) }));
      await publishPeerSource(client, {
        userId: req.user.sub,
        vault,
        deviceId: parsed.data.deviceId,
        rootKind: parsed.data.rootKind,
        relativePath: parsed.data.relativePath,
        revision: version.revision,
        sizeBytes: parsed.data.sizeBytes,
        sha256: parsed.data.sha256,
        pieces: parsed.data.pieces ?? [],
      });
    }
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to publish desktop peer availability' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/peer/tickets/validate', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncPeerTicketValidateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  try {
    const ticket = verifyPeerTicket(parsed.data.ticket);
    if (ticket.userId !== req.user.sub) return res.status(403).json({ error: 'Peer ticket user mismatch' });
    if (parsed.data.deviceId && sanitizeDeviceId(parsed.data.deviceId) !== sanitizeDeviceId(ticket.sourceDeviceId)) {
      return res.status(403).json({ error: 'Peer ticket device mismatch' });
    }
    return res.json({
      ok: true,
      ticket: {
        kind: ticket.kind ?? 'peer_file',
        vaultId: ticket.vaultId,
        manifestId: ticket.manifestId ?? null,
        shardId: ticket.shardId ?? null,
        shardIndex: ticket.shardIndex ?? null,
        pieceIndex: ticket.pieceIndex ?? null,
        offsetBytes: ticket.offsetBytes ?? null,
        sizeBytes: ticket.sizeBytes ?? null,
        sha256: ticket.sha256 ?? null,
        path: ticket.path,
        rootKind: ticket.rootKind,
        sourceDeviceId: ticket.sourceDeviceId,
        targetDeviceId: ticket.targetDeviceId,
        expiresAt: ticket.expiresAt,
      },
    });
  } catch (error) {
    return res.status(400).json({ error: error.message ?? 'Invalid peer ticket' });
  }
});

app.post('/api/sync/raid/register', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncRaidRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  if (!isPeerMode()) return res.status(409).json({ error: 'RAID registration is only available in desktop peer mode' });
  if (!isRaidEligibleRoot(parsed.data.rootKind)) return res.status(409).json({ error: 'RAID reserve is only enabled for user vault files' });

  const vault = await getOwnedVaultByType(req.user.sub, parsed.data.rootKind);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const relativePath = normalizeRelativePath(parsed.data.relativePath);
  const fileRow = await pool.query(
    'SELECT id FROM vault_items WHERE vault_id = $1 AND path = $2 AND revision = $3 AND item_type = $4',
    [vault.id, relativePath, parsed.data.revision, 'file'],
  );
  if (!fileRow.rowCount) return res.status(404).json({ error: 'File revision not found for RAID registration' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId: parsed.data.deviceId });
    const manifest = await registerRaidManifest(client, {
      userId: req.user.sub,
      vault,
      fileId: fileRow.rows[0].id,
      rootKind: parsed.data.rootKind,
      relativePath,
      revision: parsed.data.revision,
      sizeBytes: parsed.data.sizeBytes,
      sha256: parsed.data.sha256,
      shardBytes: parsed.data.shardBytes,
      shards: parsed.data.shards,
      deviceId: parsed.data.deviceId,
    });
    await client.query('COMMIT');
    return res.status(201).json({
      ok: true,
      manifestId: manifest?.manifestId ?? null,
      raid: manifest ? await getRaidManifestSummary(req.user.sub, vault.id, relativePath, parsed.data.revision, parsed.data.deviceId) : null,
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(error.status ?? 500).json({ error: error.message ?? 'Failed to register RAID manifest' });
  } finally {
    client.release();
  }
});

app.get('/api/sync/raid/assignments', authenticate, authorize('user', 'admin'), async (req, res) => {
  const deviceId = sanitizeDeviceId(req.query.deviceId);
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId });
    await refreshRaidHealthForUser(client, req.user.sub);
    const assignments = await client.query(
      `SELECT h.id AS host_id, h.shard_id, h.host_device_id, h.status, h.size_bytes, h.local_path,
              s.shard_index, s.shard_role, s.sha256,
              m.id AS manifest_id, m.vault_id, m.path, m.root_kind, m.revision, m.size_bytes AS file_size_bytes, m.source_device_id
       FROM raid_shard_hosts h
       JOIN raid_shards s ON s.id = h.shard_id
       JOIN raid_manifests m ON m.id = s.manifest_id
       WHERE h.user_id = $1
         AND h.host_device_id = $2
         AND h.status IN ('assigned', 'repairing', 'available')
         AND m.status IN ('pending', 'protected', 'degraded', 'repairing')
       ORDER BY m.updated_at DESC, s.shard_index ASC`,
      [req.user.sub, deviceId],
    );
    const peerSourceCache = new Map();
    const payloadAssignments = [];
    for (const row of assignments.rows) {
      const cacheKey = `${row.vault_id}:${row.path}:${row.revision}`;
      if (!peerSourceCache.has(cacheKey)) {
        peerSourceCache.set(
          cacheKey,
          await listPeerSourcesForPath(req.user.sub, row.vault_id, row.path, deviceId, deviceId, Number(row.revision)),
        );
      }
      const sources = peerSourceCache.get(cacheKey);
      const preferredSource = sources.find((source) => source.device_id !== deviceId) ?? null;
      payloadAssignments.push({
        hostId: row.host_id,
        shardId: row.shard_id,
        shardIndex: Number(row.shard_index),
        shardRole: row.shard_role,
        sizeBytes: Number(row.size_bytes ?? 0),
        sha256: row.sha256,
        status: row.status,
        localPath: row.local_path,
        manifest: {
          manifestId: row.manifest_id,
          path: row.path,
          rootKind: row.root_kind,
          revision: Number(row.revision),
          fileSizeBytes: Number(row.file_size_bytes ?? 0),
        },
        source: preferredSource ? {
          deviceId: preferredSource.device_id,
          endpointUrl: preferredSource.endpoint_url,
          ticket: signPeerTicket({
            kind: 'raid_source_file',
            userId: req.user.sub,
            sourceDeviceId: preferredSource.device_id,
            targetDeviceId: deviceId,
            manifestId: row.manifest_id,
            shardId: row.shard_id,
            shardIndex: Number(row.shard_index),
            rootKind: row.root_kind,
            path: row.path,
            expiresAt: Date.now() + 5 * 60 * 1000,
          }),
        } : null,
      });
    }
    await client.query('COMMIT');
    return res.json({ assignments: payloadAssignments });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to load RAID assignments' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/raid/host/confirm', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncRaidHostConfirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const device = await ensureSyncDevice(client, req.user.sub, { deviceId: parsed.data.deviceId });
    const shard = await client.query(
      `SELECT s.sha256, s.size_bytes
       FROM raid_shards s
       JOIN raid_manifests m ON m.id = s.manifest_id
       WHERE s.id = $1 AND m.id = $2 AND m.user_id = $3`,
      [parsed.data.shardId, parsed.data.manifestId, req.user.sub],
    );
    if (!shard.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RAID shard not found' });
    }
    if (shard.rows[0].sha256 !== parsed.data.sha256) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'RAID shard hash mismatch' });
    }
    const host = await client.query(
      `UPDATE raid_shard_hosts
       SET status = 'available',
           endpoint_url = COALESCE($4, endpoint_url),
           local_path = COALESCE($5, local_path),
           size_bytes = $6,
           last_confirmed_at = NOW(),
           updated_at = NOW()
       WHERE id = $1 AND shard_id = $2 AND user_id = $3 AND host_device_id = $7
       RETURNING shard_id`,
      [
        parsed.data.hostId,
        parsed.data.shardId,
        req.user.sub,
        device.peer_endpoint_url ?? null,
        parsed.data.localPath ?? null,
        parsed.data.sizeBytes,
        sanitizeDeviceId(parsed.data.deviceId),
      ],
    );
    if (!host.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'RAID shard host assignment not found' });
    }
    await client.query(
      `UPDATE raid_repair_jobs
       SET status = 'completed', updated_at = NOW()
       WHERE manifest_id = $1 AND shard_id = $2 AND target_device_id = $3 AND status IN ('pending', 'in_progress')`,
      [parsed.data.manifestId, parsed.data.shardId, sanitizeDeviceId(parsed.data.deviceId)],
    );
    const manifest = await reconcileRaidManifest(client, parsed.data.manifestId);
    await createRaidRepairJobsForManifest(client, parsed.data.manifestId);
    await client.query('COMMIT');
    return res.json({ ok: true, manifest });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to confirm RAID shard host' });
  } finally {
    client.release();
  }
});

app.get('/api/sync/raid/status', authenticate, authorize('user', 'admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await runRaidMaintenanceForUser(client, req.user.sub);
    const status = await buildRaidStatusForUser(client, req.user.sub, sanitizeDeviceId(req.query.deviceId));
    await client.query('COMMIT');
    return res.json(status);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to load RAID status' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/raid/repair', authenticate, authorize('user', 'admin'), async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await runRaidMaintenanceForUser(client, req.user.sub);
    const status = await buildRaidStatusForUser(client, req.user.sub, sanitizeDeviceId(req.query.deviceId));
    await client.query('COMMIT');
    return res.json({ ok: true, result, status });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to run RAID repair' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/files/register', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncFileRegisterSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const vault = await getOwnedVaultByType(req.user.sub, parsed.data.rootKind);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const itemPath = normalizeRelativePath(parsed.data.relativePath);
  const quota = await getPackageAndUsage(req.user.sub);
  const existingSize = await pool.query(
    `SELECT size_bytes
     FROM vault_items
     WHERE vault_id = $1 AND path = $2 AND item_type = 'file'`,
    [vault.id, itemPath],
  );
  const projectedUsedBytes = quota.usedBytes - Number(existingSize.rows[0]?.size_bytes ?? 0) + parsed.data.sizeBytes;
  if (projectedUsedBytes > Number(quota.package.user_quota_bytes)) {
    return res.status(413).json({ error: '5GB user quota exceeded', quota });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId: parsed.data.deviceId });
    const saved = await upsertPeerMetadataEntry(client, {
      userId: req.user.sub,
      vault,
      itemPath,
      mimeType: parsed.data.mimeType ?? 'application/octet-stream',
      sizeBytes: parsed.data.sizeBytes,
      sha256: parsed.data.sha256,
      deviceId: parsed.data.deviceId,
    });
    await publishPeerSource(client, {
      userId: req.user.sub,
      vault,
      deviceId: parsed.data.deviceId,
      rootKind: parsed.data.rootKind,
      relativePath: itemPath,
      revision: saved.revision,
      sizeBytes: parsed.data.sizeBytes,
      sha256: parsed.data.sha256,
    });
    await client.query('COMMIT');
    for (const objectKey of saved.oldObjectKeys) {
      await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
    }
    return res.status(201).json({ item: saved.item, transportMode: SYNC_TRANSPORT_MODE });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(error.status ?? 500).json({ error: error.message ?? 'Failed to register desktop sync file' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/files/upload', authenticate, authorize('user', 'admin'), express.raw({ type: '*/*', limit: FILE_UPLOAD_LIMIT }), async (req, res) => {
  if (isPeerMode()) {
    return res.status(409).json({ error: 'Desktop peer mode is enabled. Use /api/sync/files/register instead.' });
  }
  const deviceId = sanitizeDeviceId(req.headers['x-device-id']);
  const rootKind = String(req.headers['x-root-kind'] ?? '');
  const relativePath = normalizeRelativePath(req.headers['x-relative-path'] ?? '/');
  const fileName = req.headers['x-file-name'];
  const password = req.headers['x-vault-password'];
  if (!deviceId || (rootKind !== 'user_vault' && rootKind !== 'share_vault') || typeof fileName !== 'string') {
    return res.status(400).json({ error: 'x-device-id, x-root-kind, x-relative-path, and x-file-name required' });
  }
  if (rootKind === 'user_vault' && typeof password !== 'string') {
    return res.status(400).json({ error: 'x-vault-password required for private vault uploads' });
  }

  let name;
  try {
    name = normalizeItemName(decodeURIComponent(fileName));
  } catch {
    return res.status(400).json({ error: 'Invalid file name' });
  }

  const vault = await getOwnedVaultByType(req.user.sub, rootKind);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });
  const plaintext = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
  const quota = await getPackageAndUsage(req.user.sub);
  const itemPath = joinVaultPath(relativePath, name);
  const existingSize = await pool.query(
    `SELECT size_bytes
     FROM vault_items
     WHERE vault_id = $1 AND path = $2 AND item_type = 'file'`,
    [vault.id, itemPath],
  );
  const projectedUsedBytes = quota.usedBytes - Number(existingSize.rows[0]?.size_bytes ?? 0) + plaintext.length;
  if (projectedUsedBytes > Number(quota.package.user_quota_bytes)) {
    return res.status(413).json({ error: '5GB user quota exceeded', quota });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId });
    const uploaded = await upsertFileEntry(client, {
      userId: req.user.sub,
      vault,
      parentPath: relativePath,
      name,
      plaintext,
      mimeType: req.headers['content-type'] ?? 'application/octet-stream',
      password: typeof password === 'string' ? password : '',
      deviceId,
    });
    await client.query('COMMIT');
    for (const objectKey of uploaded.oldObjectKeys) {
      await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
    }
    return res.status(201).json({ item: uploaded.item });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(error.status ?? 500).json({ error: error.message ?? 'Failed to upload sync file' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/files/delete', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncPathDeleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const vault = await getOwnedVaultByType(req.user.sub, parsed.data.rootKind);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId: parsed.data.deviceId });
    const normalizedPath = normalizeRelativePath(parsed.data.relativePath);
    await unpublishPeerSource(client, {
      userId: req.user.sub,
      vault,
      deviceId: parsed.data.deviceId,
      relativePath: normalizedPath,
    });
    await client.query(
      'DELETE FROM sync_peer_sources WHERE user_id = $1 AND vault_id = $2 AND device_id = $3 AND path LIKE $4',
      [req.user.sub, vault.id, parsed.data.deviceId, `${normalizedPath}/%`],
    );
    await client.query(
      'DELETE FROM sync_peer_pieces WHERE user_id = $1 AND vault_id = $2 AND device_id = $3 AND path LIKE $4',
      [req.user.sub, vault.id, parsed.data.deviceId, `${normalizedPath}/%`],
    );
    await deleteRaidMetadataForPath(client, vault.id, normalizedPath);
    const deleted = await deleteVaultPath(client, {
      userId: req.user.sub,
      vault,
      itemPath: normalizedPath,
      deviceId: parsed.data.deviceId,
    });
    await client.query('COMMIT');
    for (const objectKey of deleted.objectKeys) {
      await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
    }
    return res.json({ ok: true, deleted: deleted.deleted });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(error.status ?? 500).json({ error: error.message ?? 'Failed to delete sync file' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/folders/create', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncFolderCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const vault = await getOwnedVaultByType(req.user.sub, parsed.data.rootKind);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId: parsed.data.deviceId });
    const folder = await createFolderEntry(client, {
      userId: req.user.sub,
      vault,
      parentPath: normalizeRelativePath(parsed.data.parentPath),
      name: normalizeItemName(parsed.data.name),
      deviceId: parsed.data.deviceId,
    });
    await client.query('COMMIT');
    return res.status(201).json({ item: folder });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(error.status ?? 500).json({ error: error.message ?? 'Failed to create sync folder' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/folders/delete', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncPathDeleteSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const vault = await getOwnedVaultByType(req.user.sub, parsed.data.rootKind);
  if (!vault) return res.status(404).json({ error: 'Vault not found' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await ensureSyncDevice(client, req.user.sub, { deviceId: parsed.data.deviceId });
    const normalizedPath = normalizeRelativePath(parsed.data.relativePath);
    await client.query(
      'DELETE FROM sync_peer_sources WHERE user_id = $1 AND vault_id = $2 AND (path = $3 OR path LIKE $4)',
      [req.user.sub, vault.id, normalizedPath, `${normalizedPath}/%`],
    );
    await client.query(
      'DELETE FROM sync_peer_pieces WHERE user_id = $1 AND vault_id = $2 AND (path = $3 OR path LIKE $4)',
      [req.user.sub, vault.id, normalizedPath, `${normalizedPath}/%`],
    );
    await deleteRaidMetadataForPath(client, vault.id, normalizedPath);
    const deleted = await deleteVaultPath(client, {
      userId: req.user.sub,
      vault,
      itemPath: normalizeRelativePath(parsed.data.relativePath),
      deviceId: parsed.data.deviceId,
    });
    await client.query('COMMIT');
    for (const objectKey of deleted.objectKeys) {
      await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
    }
    return res.json({ ok: true, deleted: deleted.deleted });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(error.status ?? 500).json({ error: error.message ?? 'Failed to delete sync folder' });
  } finally {
    client.release();
  }
});

app.post('/api/sync/ack', authenticate, authorize('user', 'admin'), async (req, res) => {
  const parsed = syncAckSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const device = await ensureSyncDevice(client, req.user.sub, {
      deviceId: parsed.data.deviceId,
      localRoots: parsed.data.localRoots ?? {},
    });
    await client.query(
      `UPDATE sync_devices
       SET last_cursor = GREATEST(last_cursor, $3), updated_at = NOW()
       WHERE user_id = $1 AND device_id = $2`,
      [req.user.sub, parsed.data.deviceId, parsed.data.cursor],
    );
    await client.query('COMMIT');
    return res.json({ ok: true, deviceId: device.device_id, cursor: parsed.data.cursor });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to acknowledge sync cursor' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/users', authenticate, authorize('admin'), async (_req, res) => {
  const users = await pool.query(
    `SELECT u.id, u.email, u.role, u.created_at,
            COALESCE(p.used_bytes, 0)::BIGINT AS used_bytes,
            COALESCE(pkg.user_quota_bytes, $1)::BIGINT AS user_quota_bytes
     FROM app_users u
     LEFT JOIN vault_packages pkg ON pkg.user_id = u.id
     LEFT JOIN (
       SELECT v.user_id, SUM(i.size_bytes) AS used_bytes
       FROM vaults v
       JOIN vault_items i ON i.vault_id = v.id AND i.item_type = 'file'
       GROUP BY v.user_id
     ) p ON p.user_id = u.id
     ORDER BY u.created_at DESC`,
    [FIVE_GB],
  );
  res.json({ users: users.rows });
});

app.get('/api/admin/raid/status', authenticate, authorize('admin'), async (_req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const users = await client.query('SELECT id, email, role FROM app_users ORDER BY created_at DESC');
    const rows = [];
    for (const user of users.rows) {
      await runRaidMaintenanceForUser(client, user.id);
      rows.push({
        user,
        status: await buildRaidStatusForUser(client, user.id, 'admin-web'),
      });
    }
    await client.query('COMMIT');
    const totals = rows.reduce(
      (acc, row) => {
        acc.reserveBytes += row.status.reserveBytes;
        acc.reserveUsedBytes += row.status.reserveUsedBytes;
        acc.activeReservePeers += row.status.activeReservePeers;
        acc.manifests += row.status.summary.total;
        acc.protected += row.status.summary.protected;
        acc.degraded += row.status.summary.degraded;
        acc.pending += row.status.summary.pending;
        return acc;
      },
      { reserveBytes: 0, reserveUsedBytes: 0, activeReservePeers: 0, manifests: 0, protected: 0, degraded: 0, pending: 0 },
    );
    return res.json({ totals, users: rows });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to load admin RAID status' });
  } finally {
    client.release();
  }
});

app.post('/api/admin/raid/repair', authenticate, authorize('admin'), async (req, res) => {
  const parsed = adminRaidRepairSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const users = parsed.data.userId
      ? await client.query('SELECT id, email, role FROM app_users WHERE id = $1', [parsed.data.userId])
      : await client.query('SELECT id, email, role FROM app_users ORDER BY created_at DESC');
    const results = [];
    for (const user of users.rows) {
      results.push({
        user,
        result: await runRaidMaintenanceForUser(client, user.id),
        status: await buildRaidStatusForUser(client, user.id, 'admin-web'),
      });
    }
    await client.query('COMMIT');
    return res.json({ ok: true, users: results });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error(error);
    return res.status(500).json({ error: 'Failed to run admin RAID repair' });
  } finally {
    client.release();
  }
});

app.get('/api/admin/backups', authenticate, authorize('admin'), async (_req, res) => {
  try {
    return res.json(await callBackup('/backups'));
  } catch (error) {
    console.error(error);
    return res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to list backups' });
  }
});

app.post('/api/admin/backups/create', authenticate, authorize('admin'), async (_req, res) => {
  try {
    return res.status(201).json(await callBackup('/create', { method: 'POST' }));
  } catch (error) {
    console.error(error);
    return res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to create backup' });
  }
});

app.get('/api/admin/backups/status', authenticate, authorize('admin'), async (_req, res) => {
  try {
    return res.json(await callBackup('/status'));
  } catch (error) {
    console.error(error);
    return res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to load backup status' });
  }
});

app.get('/api/admin/backups/:id/download', authenticate, authorize('admin'), async (req, res) => {
  try {
    const result = await callBackup(`/download/${encodeURIComponent(req.params.id)}`, { responseType: 'arrayBuffer' });
    res.setHeader('content-type', result.contentType);
    if (result.contentDisposition) res.setHeader('content-disposition', result.contentDisposition);
    return res.send(result.body);
  } catch (error) {
    console.error(error);
    return res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to download backup' });
  }
});

app.post(
  '/api/admin/backups/upload',
  authenticate,
  authorize('admin'),
  express.raw({ type: '*/*', limit: process.env.BACKUP_UPLOAD_LIMIT ?? '500mb' }),
  async (req, res) => {
    try {
      const payload = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
      const result = await callBackup('/upload', {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? 'application/octet-stream' },
        body: payload,
      });
      return res.status(201).json(result);
    } catch (error) {
      console.error(error);
      return res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to upload backup' });
    }
  },
);

app.post('/api/admin/backups/:id/restore', authenticate, authorize('admin'), async (req, res) => {
  try {
    return res.json(await callBackup(`/restore/${encodeURIComponent(req.params.id)}`, { method: 'POST' }));
  } catch (error) {
    console.error(error);
    return res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to restore backup' });
  }
});

app.get('/api/admin/system/update/check', authenticate, authorize('admin'), async (_req, res) => {
  try {
    const result = await callUpdater('/check');
    await saveSystemUpdateRecord({ ...result, status: result.hasUpdate ? 'update_available' : 'up_to_date' });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to check updates' });
  }
});

app.post('/api/admin/system/update/apply', authenticate, authorize('admin'), async (_req, res) => {
  try {
    const result = await callUpdater('/apply', { method: 'POST' });
    await saveSystemUpdateRecord({ ...result, status: result.status ?? 'started' });
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(error.status ?? 500).json(error.body ?? { error: 'Failed to apply update' });
  }
});

app.get('/api/admin/system/update/status', authenticate, authorize('admin'), async (_req, res) => {
  const history = await pool.query(
    'SELECT id, status, local_sha, remote_sha, message, logs, created_at FROM system_update_jobs ORDER BY created_at DESC LIMIT 20',
  );
  let updater = null;
  try {
    updater = await callUpdater('/status');
  } catch (error) {
    updater = { status: 'unavailable', error: error.message };
  }
  res.json({ updater, history: history.rows });
});

// Backward-compatible encrypted chunk API kept for early desktop-client experiments.
app.post('/api/chunks/upload', authenticate, authorize('user', 'admin'), express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  if (isPeerMode()) {
    return res.status(409).json({ error: 'Desktop peer mode is enabled. The Docker API does not accept vault blob uploads.' });
  }
  try {
    const { vaultId } = req.query;
    const password = req.headers['x-vault-password'];
    if (!vaultId || typeof vaultId !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'vaultId and x-vault-password required' });
    }
    const vault = await getOwnedVault(vaultId, req.user.sub);
    if (!vault) return res.status(404).json({ error: 'Vault not found' });
    const plaintext = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const dek = await resolveVaultDek(req.user.sub, vaultId, password);
    const encrypted = encryptChunk(dek, plaintext);
    const objectKey = `${vaultId}/${crypto.randomUUID()}.chunk`;
    await minioClient.putObject(getBucketName(), objectKey, encrypted.ciphertext);
    const meta = await pool.query(
      `INSERT INTO vault_chunks (vault_id, object_key, sha256, size_bytes, enc_iv, enc_tag)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, object_key, sha256, size_bytes, created_at`,
      [vaultId, objectKey, sha256Hex(plaintext), plaintext.length, encrypted.iv, encrypted.tag],
    );
    return res.status(201).json({ chunk: meta.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

app.get('/api/chunks/:chunkId/download', authenticate, authorize('user', 'admin'), async (req, res) => {
  try {
    const password = req.headers['x-vault-password'];
    if (typeof password !== 'string') return res.status(400).json({ error: 'x-vault-password required' });
    const chunkResult = await pool.query(
      `SELECT c.id, c.vault_id, c.object_key, c.enc_iv, c.enc_tag
       FROM vault_chunks c
       JOIN vaults v ON v.id = c.vault_id
       WHERE c.id = $1 AND v.user_id = $2`,
      [req.params.chunkId, req.user.sub],
    );
    if (!chunkResult.rowCount) return res.status(404).json({ error: 'Chunk not found' });
    const chunk = chunkResult.rows[0];
    const dek = await resolveVaultDek(req.user.sub, chunk.vault_id, password);
    const stream = await minioClient.getObject(getBucketName(), chunk.object_key);
    const buffers = [];
    for await (const part of stream) buffers.push(part);
    const plaintext = decryptChunk(dek, Buffer.concat(buffers), chunk.enc_iv, chunk.enc_tag);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${chunk.id}.bin"`);
    return res.send(plaintext);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to download chunk' });
  }
});

app.use((error, _req, res, _next) => {
  if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
    return res.status(400).json({ error: 'Invalid JSON request body' });
  }
  console.error(error);
  return res.status(error?.status ?? 500).json({ error: error?.message ?? 'Internal server error' });
});

const port = Number(process.env.API_PORT ?? 3000);
runMigrations()
  .then(() => (isPeerMode() ? undefined : ensureBucket()))
  .then(ensureDefaultAdmin)
  .then(() => app.listen(port, () => console.log(`API listening on ${port}`)))
  .catch((error) => {
    console.error('Startup failed', error);
    process.exit(1);
  });
