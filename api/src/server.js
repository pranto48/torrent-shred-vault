import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import crypto from 'node:crypto';
import { z } from 'zod';
import { pool, runMigrations } from './db.js';
import { authenticate, authorize, signToken } from './auth.js';
import { decryptChunk, deriveKek, encryptChunk, generateDek, hashPassword, sha256Hex, unwrapDek, verifyPassword, wrapDek } from './crypto.js';
import { ensureBucket, getBucketName, minioClient } from './storage.js';

const app = express();
app.use(cors());
app.use(express.json());

const registerSchema = z.object({ email: z.string().email(), password: z.string().min(8), role: z.enum(['user', 'admin']).optional() });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(8) });
const createVaultSchema = z.object({ type: z.enum(['user_vault', 'share_vault']), name: z.string().min(1).max(120).optional() });

async function resolveVaultDek(userId, vaultId, password) {
  const sec = await pool.query('SELECT salt FROM user_security WHERE user_id = $1', [userId]);
  const wrap = await pool.query('SELECT wrapped_dek, wrap_iv, wrap_tag FROM vault_keys WHERE vault_id = $1 AND key_version = 1', [vaultId]);
  if (!sec.rowCount || !wrap.rowCount) throw new Error('Missing key material');
  const kek = await deriveKek(password, sec.rows[0].salt);
  return unwrapDek(kek, wrap.rows[0].wrapped_dek, wrap.rows[0].wrap_iv, wrap.rows[0].wrap_tag);
}
async function createWrappedDekForVault(client, userId, password, vaultId) {
  const salt = crypto.randomBytes(16); const kek = await deriveKek(password, salt); const passwordHash = await hashPassword(password);
  const dek = generateDek(); const wrapped = wrapDek(kek, dek);
  await client.query(`INSERT INTO user_security (user_id, password_hash, salt) VALUES ($1, $2, $3) ON CONFLICT (user_id) DO NOTHING`, [userId, passwordHash, salt]);
  await client.query(`INSERT INTO vault_keys (vault_id, key_version, wrapped_dek, wrap_iv, wrap_tag) VALUES ($1, 1, $2, $3, $4) ON CONFLICT (vault_id, key_version) DO NOTHING`, [vaultId, wrapped.ciphertext, wrapped.iv, wrapped.tag]);
}
async function createDefaultVaultsForUser(client, userId, password) {
  const result = await client.query(`INSERT INTO vaults (user_id, type, name) VALUES ($1,'user_vault','User Vault'),($1,'share_vault','Share Vault') ON CONFLICT (user_id, type) DO UPDATE SET name=EXCLUDED.name RETURNING id`, [userId]);
  for (const row of result.rows) await createWrappedDekForVault(client, userId, password, row.id);
}
async function ensureDefaultAdmin() { /* unchanged */ const email = process.env.DEFAULT_ADMIN_EMAIL; const password = process.env.DEFAULT_ADMIN_PASSWORD; if (!email||!password) return; const e=await pool.query('SELECT id FROM app_users WHERE email=$1',[email]); if(e.rowCount)return; const c=await pool.connect(); try{await c.query('BEGIN'); const r=await c.query('INSERT INTO app_users (email,password_hash,role) VALUES ($1,$2,$3) RETURNING id',[email,'moved-to-user_security','admin']); await createDefaultVaultsForUser(c,r.rows[0].id,password); await c.query('COMMIT');}catch(err){await c.query('ROLLBACK'); throw err;} finally{c.release();}}

app.get('/health', async (_req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); });
app.post('/api/auth/register', async (req,res)=>{ const p=registerSchema.safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.flatten()}); const {email,password,role='user'}=p.data; const c=await pool.connect(); try{await c.query('BEGIN'); const r=await c.query('INSERT INTO app_users (email,password_hash,role) VALUES ($1,$2,$3) RETURNING id,email,role,created_at',[email,'moved-to-user_security',role]); await createDefaultVaultsForUser(c,r.rows[0].id,password); await c.query('COMMIT'); return res.status(201).json({user:r.rows[0],token:signToken(r.rows[0])});} catch(e){await c.query('ROLLBACK'); if(e.code==='23505')return res.status(409).json({error:'Email already exists'}); return res.status(500).json({error:'Internal server error'});} finally{c.release();}});
app.post('/api/auth/login', async (req,res)=>{ const p=loginSchema.safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.flatten()}); const {email,password}=p.data; const ur=await pool.query('SELECT id,email,role FROM app_users WHERE email=$1',[email]); if(!ur.rowCount)return res.status(401).json({error:'Invalid credentials'}); const u=ur.rows[0]; const sr=await pool.query('SELECT password_hash FROM user_security WHERE user_id=$1',[u.id]); if(!sr.rowCount||!(await verifyPassword(sr.rows[0].password_hash,password))) return res.status(401).json({error:'Invalid credentials'}); res.json({token:signToken(u),user:u}); });
app.get('/api/me', authenticate, async (req,res)=>res.json({user:(await pool.query('SELECT id,email,role,created_at FROM app_users WHERE id=$1',[req.user.sub])).rows[0]}));
app.get('/api/admin/users', authenticate, authorize('admin'), async (_req,res)=>res.json({users:(await pool.query('SELECT id,email,role,created_at FROM app_users ORDER BY created_at DESC')).rows}));
app.post('/api/vaults', authenticate, authorize('user','admin'), async (req,res)=>{ const p=createVaultSchema.safeParse(req.body); if(!p.success)return res.status(400).json({error:p.error.flatten()}); const {type,name}=p.data; const n=name??(type==='user_vault'?'User Vault':'Share Vault'); const r=await pool.query('INSERT INTO vaults (user_id,type,name) VALUES ($1,$2,$3) ON CONFLICT (user_id,type) DO UPDATE SET name=EXCLUDED.name RETURNING id,user_id,type,name,created_at',[req.user.sub,type,n]); res.status(201).json({vault:r.rows[0]});});
app.get('/api/vaults', authenticate, authorize('user','admin'), async (req,res)=>res.json({vaults:(await pool.query('SELECT id,user_id,type,name,created_at FROM vaults WHERE user_id=$1 ORDER BY created_at ASC',[req.user.sub])).rows}));

app.post('/api/chunks/upload', authenticate, authorize('user','admin'), express.raw({ type: 'application/octet-stream', limit: '50mb' }), async (req, res) => {
  try {
    const { vaultId } = req.query;
    const password = req.headers['x-vault-password'];
    if (!vaultId || typeof vaultId !== 'string' || typeof password !== 'string') return res.status(400).json({ error: 'vaultId and x-vault-password required' });
    const owns = await pool.query('SELECT id FROM vaults WHERE id = $1 AND user_id = $2', [vaultId, req.user.sub]);
    if (!owns.rowCount) return res.status(404).json({ error: 'Vault not found' });

    const dek = await resolveVaultDek(req.user.sub, vaultId, password);
    const plaintext = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body);
    const encrypted = encryptChunk(dek, plaintext);
    const objectKey = `${vaultId}/${crypto.randomUUID()}.chunk`;
    await minioClient.putObject(getBucketName(), objectKey, encrypted.ciphertext);

    const meta = await pool.query(
      'INSERT INTO vault_chunks (vault_id, object_key, sha256, size_bytes, enc_iv, enc_tag) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, object_key, sha256, size_bytes, created_at',
      [vaultId, objectKey, sha256Hex(plaintext), plaintext.length, encrypted.iv, encrypted.tag],
    );

    return res.status(201).json({ chunk: meta.rows[0] });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to upload chunk' });
  }
});

app.get('/api/chunks/:chunkId/download', authenticate, authorize('user','admin'), async (req, res) => {
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
    const encryptedBlob = Buffer.concat(buffers);
    const plaintext = decryptChunk(dek, encryptedBlob, chunk.enc_iv, chunk.enc_tag);

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${chunk.id}.bin"`);
    return res.send(plaintext);
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Failed to download chunk' });
  }
});

const port = Number(process.env.API_PORT ?? 3000);
runMigrations().then(ensureBucket).then(ensureDefaultAdmin).then(()=>app.listen(port,()=>console.log(`API listening on ${port}`))).catch((e)=>{console.error('Startup failed',e);process.exit(1);});
