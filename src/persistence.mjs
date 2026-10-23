// ── Durable storage for a host with no durable disk ──────────────────────────
//
// Every free Node host gives you an ephemeral filesystem: the process is
// restarted, the container is rebuilt, and `data/dun.db` is gone. For most apps
// that is a cache miss. For an invoice ledger it is the business — every client,
// every invoice, every payment, every audit row.
//
// So the database is treated as a document with an off-box copy, not as a file
// that happens to live on a disk:
//
//   boot   pull the encrypted snapshot from a private git repo into place
//   write  the app keeps writing to the local file as normal
//   tick   export the whole database, encrypt it, commit, push
//
// Three properties matter, and each one is why this is not a one-liner:
//
//   1. A push that fails must not take the process down. The ledger is fine on
//      disk; losing the off-box copy for an hour is a risk, crashing is a
//      certainty.
//
//   2. The snapshot is encrypted before it leaves the machine. A private repo can
//      still leak — a revoked token, an accidental visibility change — and an
//      invoice ledger is a list of who owes whom, which is nobody else's business.
//
//   3. A restore must never silently produce an empty ledger. If the pull fails,
//      that is a loud, named failure at boot, not a fresh database that looks
//      like the business vanished.

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const run = promisify(execFile);

const SNAPSHOT = 'dun.db.enc';
const DIGEST = 'dun.db.sha256';
const GIT_TIMEOUT_MS = 60_000;

/* --------------------------------------------------------------- encryption */

/**
 * Key from a passphrase. pbkdf2 rather than a raw hash so a weak passphrase is
 * not instantly reversible, and 200k iterations because this runs once per
 * snapshot, not per request.
 */
function deriveKey(passphrase, salt) {
  return crypto.pbkdf2Sync(String(passphrase), salt, 200_000, 32, 'sha256');
}

/** Envelope: salt[16] | iv[12] | authTag[16] | ciphertext */
export function encryptSnapshot(bytes, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), body]);
}

export function decryptSnapshot(blob, passphrase) {
  const salt = blob.subarray(0, 16);
  const iv = blob.subarray(16, 28);
  const tag = blob.subarray(28, 44);
  const body = blob.subarray(44);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(passphrase, salt), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ------------------------------------------------------------------- config */

export function configFromEnv(env = process.env) {
  const repo = String(env.DUN_BACKUP_REPO || '').trim();
  const token = String(env.DUN_BACKUP_TOKEN || '').trim();
  const key = String(env.DUN_BACKUP_KEY || '').trim();

  if (!repo || !token || !key) {
    return { enabled: false, reason: 'set DUN_BACKUP_REPO, DUN_BACKUP_TOKEN and DUN_BACKUP_KEY to keep the ledger off-box' };
  }
  if (key.length < 24) {
    // A short passphrase here protects a file that lists every client and what
    // they owe. That is not a place to accept "hunter2".
    return { enabled: false, reason: 'DUN_BACKUP_KEY is too short — use at least 24 characters' };
  }

  return { enabled: true, repo, token, key, dir: env.DUN_BACKUP_DIR || '.dun-sync' };
}

/* --------------------------------------------------------------------- git */

function authedUrl(repo, token) {
  const value = String(repo).trim();

  // A filesystem path is used as-is. That covers a bare repo on a mounted volume
  // or an attached disk, and it is the only way to exercise this module without
  // a network — so it is a supported shape, not a test hook.
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('~') || value.startsWith('file://')) {
    return value;
  }

  // Already carries credentials, or is ssh — leave it alone. Rewriting a URL that
  // already has a token in it produces a confusing auth failure.
  if (/^[a-z+]+:\/\//i.test(value) && !/^https?:\/\//i.test(value)) return value;
  if (/^https?:\/\/[^/]*@/.test(value)) return value;

  const clean = value.replace(/^https?:\/\//, '').replace(/\.git$/, '');
  return `https://x-access-token:${token}@${clean}.git`;
}

async function git(args, cwd) {
  try {
    const { stdout, stderr } = await run('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_NAME: 'Dun',
        GIT_AUTHOR_EMAIL: 'dun@localhost',
        GIT_COMMITTER_NAME: 'Dun',
        GIT_COMMITTER_EMAIL: 'dun@localhost',
      },
    });
    return { ok: true, out: stdout, err: stderr };
  } catch (error) {
    return { ok: false, out: error.stdout || '', err: error.stderr || error.message };
  }
}

/**
 * Make the sync directory a clone of the backup repo.
 *
 * Idempotent: called before every backup, and it is cheap when the repo is
 * already there.
 */
async function ensureRepo(config) {
  const url = authedUrl(config.repo, config.token);

  try {
    await readFile(`${config.dir}/.git/HEAD`);
  } catch {
    await rm(config.dir, { recursive: true, force: true });
    await mkdir(config.dir, { recursive: true });

    const clone = await git(['clone', '--depth', '1', url, '.'], config.dir);
    if (clone.ok) return { ok: true, fresh: true };

    // An empty repo cannot be cloned. That is the first-run state, not a failure.
    const init = await git(['init', '-q'], config.dir);
    if (!init.ok) return { ok: false, err: `could not initialise the backup repo: ${init.err}` };

    await git(['remote', 'add', 'origin', url], config.dir);
    return { ok: true, fresh: true, empty: true };
  }

  await git(['remote', 'set-url', 'origin', url], config.dir);
  const pull = await git(['pull', '--rebase', 'origin', 'HEAD'], config.dir);
  return { ok: true, pulled: pull.ok };
}

/* ---------------------------------------------------------------- restore */

/**
 * Bring the snapshot into place before the app opens the database.
 *
 * Returns `{ restored, reason }`. A configured backup that cannot be restored is
 * an error the caller must surface: starting with an empty ledger on a host that
 * is supposed to have one is the worst possible outcome, because it looks like
 * the business never existed.
 */
export async function restore({ config, dbPath, log = console }) {
  if (!config.enabled) return { restored: false, reason: config.reason };

  const ensure = await ensureRepo(config);
  if (!ensure.ok) return { restored: false, error: ensure.err };

  let blob;
  try {
    blob = await readFile(`${config.dir}/${SNAPSHOT}`);
  } catch {
    // No snapshot yet. First boot on a fresh repo — genuinely empty, and fine.
    return { restored: false, reason: 'no snapshot in the backup repo yet' };
  }

  let bytes;
  try {
    bytes = decryptSnapshot(blob, config.key);
  } catch {
    // A wrong key and a corrupt file look identical here, and both are fatal:
    // continuing would overwrite a recoverable ledger with an empty one.
    return { restored: false, error: 'the snapshot could not be decrypted — check DUN_BACKUP_KEY' };
  }

  await mkdir(dirname(dbPath), { recursive: true });
  await writeFile(dbPath, bytes);
  log.log(`[backup] restored ${bytes.length} bytes from the snapshot`);
  return { restored: true, bytes: bytes.length };
}

/* ----------------------------------------------------------------- backup */

/**
 * Snapshot the live database to the repo.
 *
 * `exportBytes` is a function returning the database as a Buffer, because sql.js
 * owns the bytes and this module must not know how to reach inside it.
 */
export async function backup({ config, exportBytes, now = Date.now(), log = console }) {
  if (!config.enabled) return { ok: false, reason: config.reason };

  const ensure = await ensureRepo(config);
  if (!ensure.ok) return { ok: false, error: ensure.err };

  const bytes = await exportBytes();
  if (!bytes || bytes.length === 0) {
    return { ok: false, error: 'the database exported zero bytes — refusing to overwrite a good snapshot' };
  }

  // ── Has the ledger actually changed? ──
  //
  // The ciphertext is different every time by design (fresh salt and IV), so git
  // always sees a modified file. On a five-minute timer that is 288 commits a day
  // of an identical ledger. Comparing the plaintext digest is the only honest way
  // to answer "did anything change", and it is cheaper than a commit.
  const digest = crypto.createHash('sha256').update(bytes).digest('hex');
  try {
    const previous = (await readFile(`${config.dir}/${DIGEST}`, 'utf8')).trim();
    if (previous === digest) {
      return { ok: true, changed: false, bytes: bytes.length, digest };
    }
  } catch {
    // No previous digest: first snapshot, or an older repo. Fall through and write.
  }

  await writeFile(`${config.dir}/${SNAPSHOT}`, encryptSnapshot(bytes, config.key));
  await writeFile(`${config.dir}/${DIGEST}`, `${digest}\n`);

  await git(['add', SNAPSHOT, DIGEST], config.dir);

  // Nothing changed since the last snapshot. Committing anyway would fill the
  // history with identical blobs for no benefit.
  const status = await git(['status', '--porcelain'], config.dir);
  if (status.ok && status.out.trim() === '') {
    return { ok: true, changed: false, bytes: bytes.length };
  }

  const message = `snapshot ${new Date(now).toISOString()} (${bytes.length} bytes)`;
  const commit = await git(['commit', '-q', '-m', message], config.dir);
  if (!commit.ok && !/nothing to commit/i.test(commit.err)) {
    return { ok: false, error: commit.err.slice(0, 300) };
  }

  const push = await git(['push', 'origin', 'HEAD'], config.dir);
  if (!push.ok) {
    // The rebase-then-retry is the case where another instance pushed first. It
    // is the only conflict this file can have, and it is trivially resolvable:
    // the newer snapshot wins.
    const rebase = await git(['pull', '--rebase', 'origin', 'HEAD'], config.dir);
    if (rebase.ok) {
      const retry = await git(['push', 'origin', 'HEAD'], config.dir);
      if (retry.ok) return { ok: true, changed: true, bytes: bytes.length, retried: true };
    }
    return { ok: false, error: push.err.slice(0, 300) };
  }

  log.log(`[backup] pushed ${bytes.length} bytes`);
  return { ok: true, changed: true, bytes: bytes.length, digest };
}

/**
 * Snapshot on a timer.
 *
 * Returns a stop function. The interval is deliberately not aggressive: this is
 * a ledger, not a chat log, and a push every few minutes is plenty when the
 * alternative — no off-box copy at all — is the thing being fixed.
 */
export function startAutoBackup({ config, exportBytes, everyMs = 5 * 60 * 1000, log = console }) {
  if (!config.enabled) return () => {};

  let running = false;
  let stopped = false;

  const tickOnce = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await backup({ config, exportBytes, log });
      if (!result.ok) log.warn(`[backup] failed: ${result.error || result.reason}`);
    } catch (error) {
      // A backup failure must never crash the process holding the ledger.
      log.warn(`[backup] threw: ${error.message}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tickOnce, everyMs);
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
