import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const app = express();

const PORT = Number(process.env.BACKUP_PORT ?? 3200);
const BACKUP_DIR = process.env.BACKUP_DIR ?? '/backups';
const DB_HOST = process.env.DB_HOST ?? 'db';
const DB_PORT = process.env.DB_PORT ?? '5432';
const DB_NAME = process.env.DB_NAME ?? 'torrent_shred_vault';
const DB_USER = process.env.DB_USER ?? 'torrent_user';
const DB_PASSWORD = process.env.DB_PASSWORD ?? 'torrent_password';
const COMPOSE_PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME ?? 'torrent-shred-vault';
const BACKUP_ENCRYPTION_KEY = process.env.BACKUP_ENCRYPTION_KEY ?? 'change-this-backup-key';
const STATUS_FILE = path.join(BACKUP_DIR, 'status.json');
const BACKUP_FORMAT = 'torrent-shred-vault.backup.v1';

app.use((req, res, next) => {
  if (req.path === '/upload') return next();
  return express.json({ limit: '1mb' })(req, res, next);
});

function nowIso() {
  return new Date().toISOString();
}

function backupPath(id) {
  return path.join(BACKUP_DIR, `${id}.tsvbackup`);
}

function safeBackupId(input) {
  return String(input ?? '').replace(/[^a-zA-Z0-9._-]/g, '');
}

function commandEnv() {
  return {
    ...process.env,
    PGHOST: DB_HOST,
    PGPORT: DB_PORT,
    PGDATABASE: DB_NAME,
    PGUSER: DB_USER,
    PGPASSWORD: DB_PASSWORD,
  };
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? commandEnv(),
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) return resolve({ stdout, stderr });
      const error = new Error(`${command} exited with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

function deriveKey(salt) {
  return crypto.pbkdf2Sync(BACKUP_ENCRYPTION_KEY, salt, 120000, 32, 'sha256');
}

function encryptPayload(payload) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload))), cipher.final()]);
  return {
    encrypted: true,
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: body.toString('base64'),
  };
}

function decryptEnvelope(envelope) {
  if (envelope.format !== BACKUP_FORMAT || !envelope.encrypted) {
    throw new Error('Unsupported backup format');
  }
  const salt = Buffer.from(envelope.salt, 'base64');
  const iv = Buffer.from(envelope.iv, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(salt), iv);
  decipher.setAuthTag(tag);
  const json = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return JSON.parse(json);
}

function buildConfigManifest() {
  return {
    publicAppUrl: process.env.PUBLIC_APP_URL ?? '',
    syncTransportMode: process.env.SYNC_TRANSPORT_MODE ?? 'peer',
    peerDefaultPort: process.env.PEER_DEFAULT_PORT ?? '44888',
    updateRepoUrl: process.env.UPDATE_REPO_URL ?? 'https://github.com/pranto48/torrent-shred-vault.git',
    updateRepoBranch: process.env.UPDATE_REPO_BRANCH ?? 'main',
    minioBucket: process.env.MINIO_BUCKET ?? 'vault-data',
    note: 'Database and non-secret config manifest only. Vault blob bytes are not included.',
  };
}

async function readStatus() {
  try {
    return JSON.parse(await fs.readFile(STATUS_FILE, 'utf8'));
  } catch {
    return {
      status: 'idle',
      message: 'No backup or restore is running.',
      updatedAt: nowIso(),
    };
  }
}

async function writeStatus(status, patch = {}) {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const next = { status, updatedAt: nowIso(), ...patch };
  await fs.writeFile(STATUS_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function listBackups() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const names = await fs.readdir(BACKUP_DIR);
  const backups = [];
  for (const name of names.filter((value) => value.endsWith('.tsvbackup'))) {
    try {
      const fullPath = path.join(BACKUP_DIR, name);
      const stat = await fs.stat(fullPath);
      const envelope = JSON.parse(await fs.readFile(fullPath, 'utf8'));
      backups.push({
        id: envelope.manifest?.id ?? name.replace(/\.tsvbackup$/, ''),
        fileName: name,
        createdAt: envelope.manifest?.createdAt ?? stat.mtime.toISOString(),
        sizeBytes: stat.size,
        manifest: envelope.manifest ?? null,
      });
    } catch {
      backups.push({
        id: name.replace(/\.tsvbackup$/, ''),
        fileName: name,
        createdAt: null,
        sizeBytes: 0,
        manifest: null,
      });
    }
  }
  backups.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return backups;
}

async function createBackup() {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
  const id = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsv-backup-'));
  const dumpPath = path.join(tempDir, 'postgres.dump');
  try {
    await writeStatus('backup_running', { message: 'Creating Postgres dump.', backupId: id });
    await run('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--file', dumpPath]);
    const dump = await fs.readFile(dumpPath);
    const manifest = {
      id,
      app: 'torrent-shred-vault',
      format: BACKUP_FORMAT,
      version: 1,
      createdAt: nowIso(),
      dbName: DB_NAME,
      contents: ['postgres', 'config_manifest'],
      excludes: ['minio_vault_blobs'],
    };
    const payload = {
      manifest,
      config: buildConfigManifest(),
      postgresDumpBase64: dump.toString('base64'),
    };
    const encrypted = encryptPayload(payload);
    const envelope = {
      format: BACKUP_FORMAT,
      manifest,
      ...encrypted,
    };
    await fs.writeFile(backupPath(id), JSON.stringify(envelope));
    const stat = await fs.stat(backupPath(id));
    await writeStatus('idle', { message: 'Backup created.', backupId: id });
    return { backup: { id, fileName: `${id}.tsvbackup`, sizeBytes: stat.size, manifest } };
  } catch (error) {
    await writeStatus('failed', { message: 'Backup failed.', error: error.message, logs: error.stderr ?? error.stdout ?? '' });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function restartAppContainers() {
  try {
    const result = await run('docker', ['compose', '-p', COMPOSE_PROJECT_NAME, 'restart', 'api', 'app'], {
      cwd: '/workspace',
      env: { ...process.env },
    });
    return { ok: true, logs: `${result.stdout}\n${result.stderr}`.trim() };
  } catch (error) {
    return { ok: false, error: error.message, logs: `${error.stdout ?? ''}\n${error.stderr ?? ''}`.trim() };
  }
}

async function restoreBackup(id) {
  const safeId = safeBackupId(id);
  if (!safeId) throw new Error('Invalid backup id');
  const fullPath = backupPath(safeId);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tsv-restore-'));
  const dumpPath = path.join(tempDir, 'postgres.dump');
  try {
    await writeStatus('maintenance_restore_running', { message: 'Restore started.', backupId: safeId });
    const envelope = JSON.parse(await fs.readFile(fullPath, 'utf8'));
    const payload = decryptEnvelope(envelope);
    if (payload.manifest?.app !== 'torrent-shred-vault' || payload.manifest?.version !== 1) {
      throw new Error('Backup manifest is not compatible with this application.');
    }
    const dump = Buffer.from(payload.postgresDumpBase64, 'base64');
    await fs.writeFile(dumpPath, dump);
    const escapedDbName = DB_NAME.replaceAll("'", "''");
    await run('psql', [
      '--dbname',
      'postgres',
      '--set',
      'ON_ERROR_STOP=1',
      '--command',
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${escapedDbName}' AND pid <> pg_backend_pid();`,
    ]);
    const restore = await run('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-acl',
      '--dbname',
      DB_NAME,
      dumpPath,
    ]);
    const restart = await restartAppContainers();
    const finalStatus = restart.ok ? 'idle' : 'restore_complete_restart_failed';
    await writeStatus(finalStatus, {
      message: restart.ok ? 'Restore finished and app containers were restarted.' : 'Restore finished, but container restart failed.',
      backupId: safeId,
      logs: `${restore.stdout}\n${restore.stderr}\n${restart.logs ?? restart.error ?? ''}`.trim(),
    });
    return {
      ok: true,
      backupId: safeId,
      restart,
      manifest: payload.manifest,
    };
  } catch (error) {
    await writeStatus('failed', { message: 'Restore failed.', backupId: safeId, error: error.message, logs: error.stderr ?? error.stdout ?? '' });
    throw error;
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.get('/health', async (_req, res) => {
  res.json({ ok: true });
});

app.get('/status', async (_req, res) => {
  res.json(await readStatus());
});

app.get('/backups', async (_req, res) => {
  res.json({ backups: await listBackups(), status: await readStatus() });
});

app.post('/create', async (_req, res) => {
  try {
    res.status(201).json(await createBackup());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/download/:id', async (req, res) => {
  const id = safeBackupId(req.params.id);
  const fullPath = backupPath(id);
  try {
    await fs.access(fullPath);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${id}.tsvbackup"`);
    createReadStream(fullPath).pipe(res);
  } catch {
    res.status(404).json({ error: 'Backup not found' });
  }
});

app.post('/upload', express.raw({ type: '*/*', limit: process.env.BACKUP_UPLOAD_LIMIT ?? '500mb' }), async (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body ?? '');
    const envelope = JSON.parse(body.toString('utf8'));
    if (envelope.format !== BACKUP_FORMAT || envelope.manifest?.app !== 'torrent-shred-vault') {
      return res.status(400).json({ error: 'Unsupported backup file' });
    }
    const id = safeBackupId(envelope.manifest.id ?? crypto.randomUUID());
    await fs.mkdir(BACKUP_DIR, { recursive: true });
    await fs.writeFile(backupPath(id), body);
    await writeStatus('idle', { message: 'Backup uploaded.', backupId: id });
    return res.status(201).json({ backup: { id, fileName: `${id}.tsvbackup`, manifest: envelope.manifest } });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post('/restore/:id', async (req, res) => {
  try {
    res.json(await restoreBackup(req.params.id));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backup service listening on ${PORT}`);
});
