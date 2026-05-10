import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool, runMigrations } from './db.js';
import { authenticate, authorize, signToken } from './auth.js';

const app = express();
app.use(cors());
app.use(express.json());

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  role: z.enum(['user', 'admin']).optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

async function ensureDefaultAdmin() {
  const email = process.env.DEFAULT_ADMIN_EMAIL;
  const password = process.env.DEFAULT_ADMIN_PASSWORD;

  if (!email || !password) return;

  const existing = await pool.query('SELECT id FROM app_users WHERE email = $1', [email]);
  if (existing.rowCount) return;

  const passwordHash = await bcrypt.hash(password, 12);
  await pool.query('INSERT INTO app_users (email, password_hash, role) VALUES ($1, $2, $3)', [
    email,
    passwordHash,
    'admin',
  ]);
}

app.get('/health', async (_req, res) => {
  await pool.query('SELECT 1');
  res.json({ ok: true });
});

app.post('/api/auth/register', async (req, res) => {
  const payload = registerSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: payload.error.flatten() });

  const { email, password, role = 'user' } = payload.data;
  const passwordHash = await bcrypt.hash(password, 12);

  try {
    const result = await pool.query(
      'INSERT INTO app_users (email, password_hash, role) VALUES ($1, $2, $3) RETURNING id, email, role, created_at',
      [email, passwordHash, role],
    );

    const user = result.rows[0];
    const token = signToken(user);
    return res.status(201).json({ user, token });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }

    console.error(error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const payload = loginSchema.safeParse(req.body);
  if (!payload.success) return res.status(400).json({ error: payload.error.flatten() });

  const { email, password } = payload.data;
  const result = await pool.query('SELECT id, email, role, password_hash FROM app_users WHERE email = $1', [email]);
  const user = result.rows[0];

  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const token = signToken(user);
  return res.json({ token, user: { id: user.id, email: user.email, role: user.role } });
});

app.get('/api/me', authenticate, async (req, res) => {
  const result = await pool.query('SELECT id, email, role, created_at FROM app_users WHERE id = $1', [req.user.sub]);
  if (!result.rowCount) return res.status(404).json({ error: 'User not found' });
  return res.json({ user: result.rows[0] });
});

app.get('/api/admin/users', authenticate, authorize('admin'), async (_req, res) => {
  const result = await pool.query('SELECT id, email, role, created_at FROM app_users ORDER BY created_at DESC');
  return res.json({ users: result.rows });
});

app.get('/api/vaults', authenticate, authorize('user', 'admin'), (req, res) => {
  return res.json({
    vaults: [
      { id: `user-vault-${req.user.sub}`, type: 'user_vault', name: 'User Vault' },
      { id: `share-vault-${req.user.sub}`, type: 'share_vault', name: 'Share Vault' },
    ],
  });
});

const port = Number(process.env.API_PORT ?? 3000);
runMigrations()
  .then(ensureDefaultAdmin)
  .then(() => {
    app.listen(port, () => {
      console.log(`API listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error('Startup failed', error);
    process.exit(1);
  });
