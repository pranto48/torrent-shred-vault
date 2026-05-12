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
  if (req.path === '/api/files/upload' || req.path === '/api/chunks/upload') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

const TEN_GB = 10 * 1024 * 1024 * 1024;
const FIVE_GB = 5 * 1024 * 1024 * 1024;
const FILE_UPLOAD_LIMIT = process.env.FILE_UPLOAD_LIMIT ?? '200mb';
const UPDATER_URL = process.env.UPDATER_URL ?? 'http://updater:3100';
const SHARE_VAULT_SECRET = process.env.SHARE_VAULT_SECRET ?? process.env.JWT_SECRET ?? 'change-this-in-production';

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['user', 'admin']).optional(),
});
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const createVaultSchema = z.object({
  type: z.enum(['user_vault', 'share_vault']),
  name: z.string().min(1).max(120).optional(),
});
const folderSchema = z.object({
  vaultId: z.string().uuid(),
  path: z.string().optional(),
  name: z.string().min(1).max(180),
});

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

  if (vaultType === 'share_vault') {
    const serverWrapped = wrapDek(serverKek(), dek);
    await client.query(
      `INSERT INTO vault_server_keys (vault_id, key_version, wrapped_dek, wrap_iv, wrap_tag)
       VALUES ($1, 1, $2, $3, $4)
       ON CONFLICT (vault_id) DO NOTHING`,
      [vaultId, serverWrapped.ciphertext, serverWrapped.iv, serverWrapped.tag],
    );
  }
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

async function ensureShareServerKey(vault, ownerPassword) {
  if (vault.type !== 'share_vault') return;
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
    `SELECT id, vault_id, parent_path, path, name, item_type, mime_type, size_bytes, created_at, updated_at
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
  const path = joinVaultPath(parentPath, name);

  try {
    const folder = await pool.query(
      `INSERT INTO vault_items (vault_id, parent_path, path, name, item_type)
       VALUES ($1, $2, $3, $4, 'folder')
       RETURNING id, vault_id, parent_path, path, name, item_type, size_bytes, created_at, updated_at`,
      [vault.id, parentPath, path, name],
    );
    return res.status(201).json({ item: folder.rows[0] });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Folder already exists' });
    console.error(error);
    return res.status(500).json({ error: 'Failed to create folder' });
  }
});

app.post(
  '/api/files/upload',
  authenticate,
  authorize('user', 'admin'),
  express.raw({ type: '*/*', limit: FILE_UPLOAD_LIMIT }),
  async (req, res) => {
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
    if (quota.usedBytes + plaintext.length > Number(quota.package.user_quota_bytes)) {
      return res.status(413).json({ error: '5GB user quota exceeded', quota });
    }

    const itemPath = joinVaultPath(parentPath, name);
    const objectKey = `${vault.id}/${crypto.randomUUID()}.chunk`;
    const dek = await resolveVaultDek(req.user.sub, vault.id, password);
    await ensureShareServerKey(vault, password);
    const encrypted = encryptChunk(dek, plaintext);

    const client = await pool.connect();
    try {
      await minioClient.putObject(getBucketName(), objectKey, encrypted.ciphertext);
      await client.query('BEGIN');
      const item = await client.query(
        `INSERT INTO vault_items (vault_id, parent_path, path, name, item_type, mime_type, size_bytes)
         VALUES ($1, $2, $3, $4, 'file', $5, $6)
         RETURNING id, vault_id, parent_path, path, name, item_type, mime_type, size_bytes, created_at, updated_at`,
        [vault.id, parentPath, itemPath, name, req.headers['content-type'] ?? 'application/octet-stream', plaintext.length],
      );
      const chunk = await client.query(
        `INSERT INTO file_chunks (file_id, chunk_index, object_key, sha256, size_bytes, enc_iv, enc_tag)
         VALUES ($1, 0, $2, $3, $4, $5, $6)
         RETURNING id, chunk_index, sha256, size_bytes`,
        [item.rows[0].id, objectKey, sha256Hex(plaintext), plaintext.length, encrypted.iv, encrypted.tag],
      );
      await client.query('COMMIT');
      return res.status(201).json({ item: item.rows[0], chunks: chunk.rows, quota: await getPackageAndUsage(req.user.sub) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      await minioClient.removeObject(getBucketName(), objectKey).catch(() => {});
      if (error.code === '23505') return res.status(409).json({ error: 'File already exists at this path' });
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
    `SELECT i.id, i.vault_id, i.name, i.mime_type, v.user_id
     FROM vault_items i
     JOIN vaults v ON v.id = i.vault_id
     WHERE i.id = $1 AND i.item_type = 'file' AND v.user_id = $2`,
    [req.params.fileId, req.user.sub],
  );
  if (!item.rowCount) return res.status(404).json({ error: 'File not found' });

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
  const targets = await pool.query(
    `SELECT id FROM vault_items
     WHERE vault_id = $1 AND (path = $2 OR path LIKE $3)`,
    [target.vault_id, target.path, `${target.path}/%`],
  );
  const ids = targets.rows.map((row) => row.id);
  const chunks = await pool.query('SELECT object_key FROM file_chunks WHERE file_id = ANY($1::uuid[])', [ids]);

  for (const chunk of chunks.rows) {
    await minioClient.removeObject(getBucketName(), chunk.object_key).catch(() => {});
  }

  await pool.query('DELETE FROM vault_items WHERE id = ANY($1::uuid[])', [ids]);
  res.json({ ok: true, deleted: ids.length });
});

app.get('/api/share/files', authenticate, authorize('user', 'admin'), async (req, res) => {
  const path = normalizeDirPath(req.query.path ?? '/');
  const items = await pool.query(
    `SELECT i.id, i.vault_id, i.parent_path, i.path, i.name, i.item_type, i.mime_type, i.size_bytes,
            i.created_at, i.updated_at, u.email AS owner_email
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
    `SELECT i.id, i.vault_id, i.name, i.mime_type
     FROM vault_items i
     JOIN vaults v ON v.id = i.vault_id
     WHERE i.id = $1 AND i.item_type = 'file' AND v.type = 'share_vault'`,
    [req.params.fileId],
  );
  if (!item.rowCount) return res.status(404).json({ error: 'Shared file not found' });

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
    apiBaseUrl: process.env.PUBLIC_APP_URL ?? 'http://192.168.20.5:4400',
    userId: req.user.sub,
    vaults: vaults.rows,
    quota,
    sync: {
      userDriveName: 'User Vault',
      shareDriveName: 'Share Vault',
      shareFolderName: 'Share Folder',
      encryption: 'AES-256-GCM',
      chunkSizeBytes: 1024 * 1024,
      torrentSync: 'planned',
    },
  });
});

app.get('/api/client/downloads', authenticate, authorize('user', 'admin'), (_req, res) => {
  res.json({
    downloads: [
      { platform: 'windows', status: 'planned', label: 'Windows Vault Client', url: null },
      { platform: 'android', status: 'planned', label: 'Android Vault Client', url: null },
    ],
  });
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

const port = Number(process.env.API_PORT ?? 3000);
runMigrations()
  .then(ensureBucket)
  .then(ensureDefaultAdmin)
  .then(() => app.listen(port, () => console.log(`API listening on ${port}`)))
  .catch((error) => {
    console.error('Startup failed', error);
    process.exit(1);
  });
