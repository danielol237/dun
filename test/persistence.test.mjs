// Off-box storage: the ledger surviving a host that forgets everything.
//
// Every free Node host gives an ephemeral filesystem. For most apps that is a
// cache miss. For an invoice ledger it is the business — clients, invoices,
// payments, audit trail, all gone on the next restart.
//
// The tests that matter here are the ones about what happens when the network,
// the token, or the passphrase is wrong:
//
//   - a failed push must not crash the process holding the ledger
//   - a wrong passphrase must refuse to restore rather than yield an empty ledger
//   - a zero-byte export must never overwrite a good snapshot
//
// The last two are the dangerous ones. Both would destroy real data quietly.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  encryptSnapshot,
  decryptSnapshot,
  configFromEnv,
  restore,
  backup,
} from '../src/persistence.mjs';

const run = promisify(execFile);

const KEY = 'a-long-enough-passphrase-for-the-ledger';

/* ── Encryption ───────────────────────────────────────────────────────────── */

test('a snapshot round-trips through encryption', () => {
  const original = Buffer.from('SQLite format 3\0 this is the whole ledger');
  const sealed = encryptSnapshot(original, KEY);

  assert.ok(!sealed.includes(Buffer.from('SQLite')), 'the plaintext must not appear in the ciphertext');
  assert.deepEqual(decryptSnapshot(sealed, KEY), original);
});

test('the wrong passphrase fails loudly instead of returning garbage', () => {
  // GCM authenticates. A wrong key must throw, not hand back a mangled buffer
  // that the caller would then write over the real database.
  const sealed = encryptSnapshot(Buffer.from('ledger'), KEY);
  assert.throws(() => decryptSnapshot(sealed, 'a-different-passphrase-entirely'));
});

test('a tampered snapshot is rejected', () => {
  const sealed = encryptSnapshot(Buffer.from('ledger'), KEY);
  sealed[sealed.length - 1] ^= 0xff;
  assert.throws(() => decryptSnapshot(sealed, KEY));
});

test('two snapshots of the same data differ', () => {
  // A fresh salt and IV each time. Identical ciphertext for identical ledgers
  // would leak that nothing changed, and more importantly would mean the IV is
  // fixed, which breaks GCM's guarantees outright.
  const a = encryptSnapshot(Buffer.from('same'), KEY);
  const b = encryptSnapshot(Buffer.from('same'), KEY);
  assert.notDeepEqual(a, b);
});

/* ── Configuration ────────────────────────────────────────────────────────── */

test('backup is off unless every part is configured', () => {
  assert.equal(configFromEnv({}).enabled, false);
  assert.equal(configFromEnv({ DUN_BACKUP_REPO: 'me/dun' }).enabled, false);
  assert.equal(configFromEnv({ DUN_BACKUP_REPO: 'me/dun', DUN_BACKUP_TOKEN: 't' }).enabled, false);
});

test('a short passphrase is refused', () => {
  // This key protects a file listing every client and what they owe.
  const config = configFromEnv({
    DUN_BACKUP_REPO: 'me/dun', DUN_BACKUP_TOKEN: 't', DUN_BACKUP_KEY: 'hunter2',
  });
  assert.equal(config.enabled, false);
  assert.match(config.reason, /too short/i);
});

test('a complete configuration is accepted and says why it is off otherwise', () => {
  const config = configFromEnv({
    DUN_BACKUP_REPO: 'me/dun', DUN_BACKUP_TOKEN: 't', DUN_BACKUP_KEY: KEY,
  });
  assert.equal(config.enabled, true);
  assert.equal(config.repo, 'me/dun');

  assert.match(configFromEnv({}).reason, /DUN_BACKUP_REPO/);
});

/* ── Against a real git repo ──────────────────────────────────────────────── */

/**
 * A bare repo on disk, so the git path is exercised for real rather than mocked.
 * `git push` to a local path behaves the same as to a remote for everything this
 * module does.
 */
async function localRepo() {
  const root = join(tmpdir(), `dun-backup-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  const bare = join(root, 'backup.git');
  await mkdir(root, { recursive: true });

  await run('git', ['init', '--bare', '-q', bare]);

  return {
    root,
    bare,
    // The module builds an https:// URL from this. For a local test the repo is a
    // path, so the config is handed to the functions directly rather than parsed.
    config: {
      enabled: true,
      repo: bare,
      token: 'unused',
      key: KEY,
      dir: join(root, 'sync'),
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

// The module's authedUrl assumes https. Point it at the local path instead by
// overriding the remote after the first clone.
async function seedRepo(config) {
  await mkdir(config.dir, { recursive: true });
  await run('git', ['init', '-q'], { cwd: config.dir });
  await run('git', ['remote', 'add', 'origin', config.repo], { cwd: config.dir });
}

test('a snapshot is pushed, and a fresh instance restores it', async () => {
  const repo = await localRepo();
  try {
    await seedRepo(repo.config);

    const ledger = Buffer.from('SQLite format 3\0 clients, invoices, payments');
    const pushed = await backup({
      config: repo.config,
      exportBytes: async () => ledger,
      log: { log() {}, warn() {} },
    });
    assert.equal(pushed.ok, true, pushed.error);

    // A second instance: new directory, same repo, empty disk.
    const fresh = { ...repo.config, dir: join(repo.root, 'sync2') };
    const dbPath = join(repo.root, 'restored', 'dun.db');

    const restored = await restore({ config: fresh, dbPath, log: { log() {} } });
    assert.equal(restored.error, undefined, restored.error);
    assert.equal(restored.restored, true);

    const bytes = await readFile(dbPath);
    assert.deepEqual(bytes, ledger, 'the restored ledger must be byte-identical');
  } finally {
    await repo.cleanup();
  }
});

test('a wrong passphrase refuses to restore', async () => {
  // The dangerous case: continuing here would leave an empty database in place
  // and the app would serve it as though the business had no clients.
  const repo = await localRepo();
  try {
    await seedRepo(repo.config);
    await backup({
      config: repo.config,
      exportBytes: async () => Buffer.from('the real ledger'),
      log: { log() {}, warn() {} },
    });

    const wrong = { ...repo.config, dir: join(repo.root, 'sync2'), key: 'a-completely-different-passphrase' };
    const restored = await restore({
      config: wrong,
      dbPath: join(repo.root, 'nope', 'dun.db'),
      log: { log() {} },
    });

    assert.equal(restored.restored, false);
    assert.match(String(restored.error), /could not be decrypted/i);
  } finally {
    await repo.cleanup();
  }
});

test('an empty export never overwrites a good snapshot', async () => {
  // sql.js can hand back zero bytes if it was never opened properly. Writing that
  // over the snapshot destroys the only off-box copy of the ledger.
  const repo = await localRepo();
  try {
    await seedRepo(repo.config);

    const good = await backup({
      config: repo.config,
      exportBytes: async () => Buffer.from('a real ledger with clients in it'),
      log: { log() {}, warn() {} },
    });
    assert.equal(good.ok, true);

    const bad = await backup({
      config: repo.config,
      exportBytes: async () => Buffer.alloc(0),
      log: { log() {}, warn() {} },
    });
    assert.equal(bad.ok, false);
    assert.match(String(bad.error), /zero bytes/i);

    // And the snapshot on disk is still the good one.
    const fresh = { ...repo.config, dir: join(repo.root, 'sync2') };
    const dbPath = join(repo.root, 'check', 'dun.db');
    const restored = await restore({ config: fresh, dbPath, log: { log() {} } });
    assert.equal(restored.restored, true);
    assert.match((await readFile(dbPath)).toString(), /a real ledger/);
  } finally {
    await repo.cleanup();
  }
});

test('an unchanged ledger does not create another commit', async () => {
  const repo = await localRepo();
  try {
    await seedRepo(repo.config);

    const first = await backup({
      config: repo.config,
      exportBytes: async () => Buffer.from('stable ledger'),
      log: { log() {}, warn() {} },
    });
    assert.equal(first.changed, true);

    const second = await backup({
      config: repo.config,
      exportBytes: async () => Buffer.from('stable ledger'),
      log: { log() {}, warn() {} },
    });
    assert.equal(second.ok, true);
    assert.equal(second.changed, false, 'nothing changed, so nothing is committed');
  } finally {
    await repo.cleanup();
  }
});

test('an unreachable repo returns a failure instead of throwing', async () => {
  // The process is holding the live ledger. A backup problem must be a return
  // value, never an exception that takes the service down.
  const config = {
    enabled: true,
    repo: join(tmpdir(), 'definitely-not-a-repo-xyz'),
    token: 'unused',
    key: KEY,
    dir: join(tmpdir(), `dun-sync-fail-${Date.now()}`),
  };

  const result = await backup({
    config,
    exportBytes: async () => Buffer.from('ledger'),
    log: { log() {}, warn() {} },
  });

  assert.equal(result.ok, false);
  assert.ok(result.error, 'a reason must be reported');

  await rm(config.dir, { recursive: true, force: true });
});

test('restoring from a repo with no snapshot is not an error', async () => {
  // First boot on a fresh repo. There is genuinely nothing to restore, and that
  // must not look like a failure.
  const repo = await localRepo();
  try {
    await seedRepo(repo.config);
    await writeFile(join(repo.config.dir, 'README.md'), 'dun backups\n');
    await run('git', ['add', '-A'], { cwd: repo.config.dir });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], { cwd: repo.config.dir });
    await run('git', ['push', '-q', 'origin', 'HEAD'], { cwd: repo.config.dir });

    const fresh = { ...repo.config, dir: join(repo.root, 'sync2') };
    const restored = await restore({ config: fresh, dbPath: join(repo.root, 'x', 'dun.db'), log: { log() {} } });

    assert.equal(restored.restored, false);
    assert.equal(restored.error, undefined, 'no snapshot is a normal first boot');
    assert.match(restored.reason, /no snapshot/i);
  } finally {
    await repo.cleanup();
  }
});
