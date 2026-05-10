import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, runMigrations } from './db.js';
import { authenticate, authorize, signToken } from './auth.js';
import { deriveKek, generateDek, hashPassword, verifyPassword, wrapDek } from './crypto.js';

const app = express();
app.use(cors());
app.use(express.json());

const registerSchema = z.object({ email: z.string().email(), password: z.string().min(8), role: z.enum(['user', 'admin']).optional() });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const createVaultSchema = z.object({ type: z.enum(['user_vault', 'share_vault']), name: z.string().min(1).max(120).optional() });

async function createWrappedDekForVault(client, userId, password, vaultId) {
  const salt = crypto.randomBytes(16);
  const kek = await deriveKek(password, salt);
  const passwordHash = await hashPassword(password);
  const dek = generateDek();
  const wrapped = wrapDek(kek, dek);

  await client.query(
    `INSERT INTO user_security (user_id, password_hash, salt)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, passwordHash, salt],
  );

  await client.query(
    `INSERT INTO vault_keys (vault_id, key_version, wrapped_dek, wrap_iv, wrap_tag)
     VALUES ($1, 1, $2, $3, $4)
     ON CONFLICT (vault_id, key_version) DO NOTHING`,
    [vaultId, wrapped.ciphertext, wrapped.iv, wrapped.tag],
  );
}

async function createDefaultVaultsForUser(client, userId, password) {
  const result = await client.query(
    `INSERT INTO vaults (user_id, type, name)
     VALUES ($1, 'user_vault', 'User Vault'),
            ($1, 'share_vault', 'Share Vault')
     ON CONFLICT (user_id, type) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [userId],
  );

  for (const row of result.rows) {
    await createWrappedDekForVault(client, userId, password, row.id);
  }
}

async function ensureDefaultAdmin() {
  const email = process.env.DEFAULT_ADMIN_EMAIL;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;
  if (!email || !password) return;

  const existing = await pool.query('SELECT id FROM app_users WHERE email = $1', [email]);
  if (existing.rowCount) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const created = await client.query('INSERT INTO app_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id', [email, 'moved-to-user_security', 'admin']);
    await createDefaultVaultsForUser(client, created.rows[0].id, password);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

app.get('/health', async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });

app.post('/api/auth/register', async (req, res) => {
  const payload = registerSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: payload.error.flatten() });
  const { email, password, role = 'user' } = payload.data;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('INSERT INTO app_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at', [email, 'moved-to-user_security', role]);
    const user = result.rows[0];
    await createDefaultVaultsForUser(client, user.id, password);
    await client.query('COMMIT');
    return res.status(201).json({ user, token: signToken(user) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (error.code === '23505') return res.status(409).json({ error: 'Email already exists' });
    console.error(error); return res.status(500).json({ error: 'Internal server error' });
  } finally { client.release(); }
});

app.post('/api/auth/login', async (req, res) => {
  const payload = loginSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: payload.error.flatten() });
  const { email, password } = payload.data;

  const userResult = await pool.query('SELECT id, email, role FROM app_users WHERE email = $1', [email]);
  if (!userResult.rowCount) return res.status(401).json({ error: 'Invalid credentials' });

  const user = userResult.rows[0];
  const securityResult = await pool.query('SELECT password_hash FROM user_security WHERE user_id = $1', [user.id]);
  if (!securityResult.rowCount) return res.status(401).json({ error: 'Invalid credentials' });

  const valid = await verifyPassword(securityResult.rows[0].password_hash, password);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

  return res.json({ token: signToken(user), user });
});

app.get('/api/me', authenticate, async (req, res) => {
  const result = await pool.query('SELECT id, email, role, created_at FROM app_users WHERE id = $1', [req.user.sub]);
  if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: result.rows[0] });
});
app.get('/api/admin/users', authenticate, authorize('admin'), async (_req, res) => res.json({ users: (await pool.query('SELECT id, email, role, created_at FROM app_users ORDER BY created_at DESC')).rows }));
app.post('/api/vaults', authenticate, authorize('user', 'admin'), async (req, res) => {
  const payload = createVaultSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: payload.error.flatten() });
  const { type, name } = payload.data;
  const resolvedName = name ?? (type === 'user_vault' ? 'User Vault' : 'Share Vault');
  const result = await pool.query(`INSERT INTO vaults (user_id, type, name) VALUES ($1, $2, $3) ON CONFLICT (user_id, type) DO UPDATE SET name = EXCLUDED.name RETURNING id, user_id, type, name, created_at`, [req.user.sub, type, resolvedName]);
  res.status(201).json({ vault: result.rows[0] });
});
app.get('/api/vaults', authenticate, authorize('user', 'admin'), async (req, res) => res.json({ vaults: (await pool.query('SELECT id, user_id, type, name, created_at FROM vaults WHERE user_id = $1 ORDER BY created_at ASC', [req.user.sub])).rows }));

const port = Number(process.env.API_PORT ?? 3000);
runMigrations().then(ensureDefaultAdmin).then(() => app.listen(port, () => console.log(`API listening on ${port}`))).catch((error) => { console.error('Startup failed', error); process.exit(1); });
