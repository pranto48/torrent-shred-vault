import express from 'express';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const app = express();
app.use(express.json());

const WORKSPACE = process.env.UPDATE_REPO_PATH ?? '/workspace';
const REPO_URL = process.env.UPDATE_REPO_URL ?? 'https://github.com/pranto48/torrent-shred-vault.git';
const REPO_BRANCH = process.env.UPDATE_REPO_BRANCH ?? 'main';
const COMPOSE_PROJECT_NAME = process.env.COMPOSE_PROJECT_NAME ?? 'torrent-shred-vault';
const STATE_DIR = process.env.UPDATE_STATE_DIR ?? '/state';
const STATE_FILE = path.join(STATE_DIR, 'update-status.json');
const ALLOW_DIRTY_UPDATE = (process.env.ALLOW_DIRTY_UPDATE ?? 'false') === 'true';

async function run(command, args, options = {}) {
  const result = await execFileAsync(command, args, {
    cwd: options.cwd ?? WORKSPACE,
    maxBuffer: 1024 * 1024 * 10,
    env: { ...process.env, ...(options.env ?? {}) },
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

async function readState() {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { status: 'idle', logs: '', repoUrl: REPO_URL, branch: REPO_BRANCH };
  }
}

async function writeState(patch) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  const current = await readState();
  const next = { ...current, ...patch, updatedAt: new Date().toISOString(), repoUrl: REPO_URL, branch: REPO_BRANCH };
  await fs.writeFile(STATE_FILE, JSON.stringify(next, null, 2));
  return next;
}

async function checkUpdate() {
  const localSha = (await run('git', ['rev-parse', 'HEAD'])).trim();
  const remoteRaw = await run('git', ['ls-remote', REPO_URL, REPO_BRANCH]);
  const remoteSha = remoteRaw.trim().split(/\s+/)[0] ?? '';
  return { repoUrl: REPO_URL, branch: REPO_BRANCH, localSha, remoteSha, hasUpdate: Boolean(remoteSha && localSha !== remoteSha) };
}

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/check', async (_req, res) => {
  try {
    const result = await checkUpdate();
    await writeState({ status: result.hasUpdate ? 'update_available' : 'up_to_date', ...result, message: '' });
    res.json(result);
  } catch (error) {
    await writeState({ status: 'check_failed', message: error.message });
    res.status(500).json({ error: 'Failed to check updates', message: error.message });
  }
});

app.post('/apply', async (_req, res) => {
  let logs = '';
  try {
    await writeState({ status: 'running', message: 'Fetching latest code from GitHub', logs: '' });
    const dirty = (await run('git', ['status', '--porcelain'])).trim();
    if (dirty && !ALLOW_DIRTY_UPDATE) {
      throw new Error('Refusing update because the repository has local changes. Commit/stash them or set ALLOW_DIRTY_UPDATE=true for this updater.');
    }

    logs += await run('git', ['fetch', REPO_URL, REPO_BRANCH]);
    logs += await run('git', ['reset', '--hard', 'FETCH_HEAD']);

    await writeState({ status: 'running', message: 'Rebuilding Docker containers', logs });
    logs += await run('docker', ['compose', '-p', COMPOSE_PROJECT_NAME, 'up', '-d', '--build', '--remove-orphans']);

    const check = await checkUpdate();
    const state = await writeState({ status: 'applied', message: 'Update applied and containers recreated', logs, ...check });
    res.json(state);
  } catch (error) {
    logs += `\nERROR: ${error.message}`;
    const state = await writeState({ status: 'failed', message: error.message, logs });
    res.status(500).json({ error: 'Failed to apply update', ...state });
  }
});

app.get('/status', async (_req, res) => {
  res.json(await readState());
});

const port = Number(process.env.UPDATER_PORT ?? 3100);
app.listen(port, () => console.log(`Updater listening on ${port}`));
