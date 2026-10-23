// Delivery: the outbox actually draining.
//
// The bug these cover is the whole product's central claim. The scheduler wrote
// `outbox_message` rows and marked the reminder 'sent'; nothing ever moved a row,
// so "it follows up on its own" was a table of unsent sentences. The operator
// believed clients had been chased.
//
// Four properties are load-bearing, and each is a test below:
//
//   1. Never twice. Two workers must not both deliver the same row.
//   2. Never stranded. A process that dies mid-send must not leave the row in
//      'claimed' forever — the lease has to expire.
//   3. A retry is the same message. The idempotency key must not change between
//      attempts, or a timeout that actually delivered becomes a second demand.
//   4. A permanent failure stops. Retrying a bad token forever hides the real
//      problem and buries the client who is not being chased.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../src/db.mjs';
import { audit } from '../src/domain.mjs';
import {
  claimBatch,
  deliverOne,
  dispatch,
  backoffMs,
  outboxHealth,
  CLAIM_LEASE_MS,
  MAX_ATTEMPTS,
} from '../src/delivery.mjs';

const T0 = Date.UTC(2026, 5, 1);

async function fresh() {
  return Db.open(':memory:');
}

/**
 * Insert an outbox row directly — the scheduler's own path is tested elsewhere.
 *
 * reminder_id is left NULL on purpose: the column is a foreign key to a real
 * reminder, and building a client, invoice and policy for every delivery test
 * would bury the thing under test. Delivery has to work for a row regardless of
 * where it came from, and NULL is the honest way to say "not from a reminder".
 */
function queue(db, { channel = 'email', recipient = 'ada@example.com', body = 'Invoice INV-0001 is due.', reminderId = null, now = T0 } = {}) {
  db.run(
    `INSERT INTO outbox_message (reminder_id, channel, recipient, body, state, attempts, next_attempt, created_at)
     VALUES (?,?,?,?, 'queued', 0, ?, ?)`,
    [reminderId, channel, recipient, body, now, now],
  );
  return db.lastId();
}

function row(db, id) {
  return db.row('SELECT * FROM outbox_message WHERE id = ?', [id]);
}

/** A channel that records what it was asked to send. */
function recorder({ ok = true, retryable = true, error = 'nope', providerId = 'prov-1' } = {}) {
  const sent = [];
  return {
    sent,
    channel: {
      name: 'email',
      supports: () => true,
      async send(message) {
        sent.push(message);
        return ok ? { ok: true, providerId } : { ok: false, retryable, error };
      },
    },
  };
}

/* ── Claiming ─────────────────────────────────────────────────────────────── */

test('a queued message is claimed by exactly one caller', async () => {
  const db = await fresh();
  queue(db, { now: T0 });

  const first = claimBatch(db, { now: T0 });
  assert.equal(first.length, 1);

  // The second worker arrives a moment later. It must find nothing: the row is
  // already claimed and the lease has not expired.
  const second = claimBatch(db, { now: T0 + 1000 });
  assert.equal(second.length, 0, 'the same row must not be handed to two workers');

  await db.close();
});

test('a claim that was never released can be taken over once the lease expires', async () => {
  // This is the crash case. A process that dies mid-send leaves the row in
  // 'claimed'; without a lease the client is never chased again.
  const db = await fresh();
  const id = queue(db, { now: T0 });

  claimBatch(db, { now: T0 });
  assert.equal(row(db, id).state, 'claimed');

  const later = claimBatch(db, { now: T0 + CLAIM_LEASE_MS + 1 });
  assert.equal(later.length, 1, 'an expired claim must be reclaimable');
  assert.equal(later[0].id, id);

  await db.close();
});

test('a message scheduled for the future is not claimed early', async () => {
  const db = await fresh();
  const id = queue(db, { now: T0 });
  db.run('UPDATE outbox_message SET next_attempt = ? WHERE id = ?', [T0 + 60_000, id]);

  assert.equal(claimBatch(db, { now: T0 }).length, 0, 'next_attempt is in the future');
  assert.equal(claimBatch(db, { now: T0 + 60_001 }).length, 1);

  await db.close();
});

/* ── Delivering ───────────────────────────────────────────────────────────── */

test('a delivered message is marked sent, with the provider id kept', async () => {
  const db = await fresh();
  const id = queue(db, { now: T0 });
  const { channel } = recorder({ providerId: 'smtp-abc' });

  const [claimed] = claimBatch(db, { now: T0 });
  const result = await deliverOne(db, claimed, { channels: { email: channel }, now: T0 + 10 });

  assert.equal(result.ok, true);

  const after = row(db, id);
  assert.equal(after.state, 'sent');
  assert.equal(after.provider_id, 'smtp-abc');
  assert.equal(after.sent_at, T0 + 10);
  assert.equal(after.claimed_at, null, 'the claim must be released');
  assert.equal(after.last_error, null);

  // The audit trail has to say it was delivered, or "did this send?" is a guess.
  const logged = db.row("SELECT * FROM audit_log WHERE action = 'outbox.sent' AND entity_id = ?", [id]);
  assert.ok(logged, 'a delivery must be audited');

  await db.close();
});

test('the idempotency key is stable across retries', async () => {
  // A timeout is ambiguous: the provider may have delivered it. The retry must
  // carry the same key so the duplicate collapses instead of arriving as a
  // second demand for money.
  const db = await fresh();
  const id = queue(db, { now: T0 });

  const keys = [];
  const flaky = {
    name: 'email',
    supports: () => true,
    async send(message) {
      keys.push(message.idempotencyKey);
      return keys.length === 1
        ? { ok: false, retryable: true, error: 'timeout' }
        : { ok: true, providerId: 'prov' };
    },
  };

  const [first] = claimBatch(db, { now: T0 });
  await deliverOne(db, first, { channels: { email: flaky }, now: T0 });

  const retryAt = row(db, id).next_attempt;
  const [second] = claimBatch(db, { now: retryAt });
  await deliverOne(db, second, { channels: { email: flaky }, now: retryAt });

  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], 'the retry must be recognisable as the same message');
  assert.ok(keys[0].length > 0, 'the key must not be empty');

  await db.close();
});

test('a retryable failure goes back to the queue with a growing delay', async () => {
  const db = await fresh();
  const id = queue(db, { now: T0 });
  const { channel } = recorder({ ok: false, retryable: true, error: 'connection reset' });

  const [claimed] = claimBatch(db, { now: T0 });
  const result = await deliverOne(db, claimed, { channels: { email: channel }, now: T0 });

  assert.equal(result.ok, false);
  assert.equal(result.dead, false);

  const after = row(db, id);
  assert.equal(after.state, 'queued');
  assert.equal(after.attempts, 1);
  assert.equal(after.last_error, 'connection reset');
  assert.equal(after.next_attempt, T0 + backoffMs(1));
  assert.ok(after.next_attempt > T0, 'a retry must wait, not hammer');

  await db.close();
});

test('a permanent failure dies immediately instead of retrying', async () => {
  // A 401 will still be a 401 in five minutes. Retrying it fills the log and
  // hides the fact that nobody is being chased.
  const db = await fresh();
  const id = queue(db, { now: T0 });
  const { channel, sent } = recorder({ ok: false, retryable: false, error: '401 unauthorised' });

  const [claimed] = claimBatch(db, { now: T0 });
  const result = await deliverOne(db, claimed, { channels: { email: channel }, now: T0 });

  assert.equal(result.dead, true);
  assert.equal(sent.length, 1);

  const after = row(db, id);
  assert.equal(after.state, 'dead');
  assert.equal(after.last_error, '401 unauthorised');

  await db.close();
});

test('a message dies after the attempt ceiling', async () => {
  const db = await fresh();
  const id = queue(db, { now: T0 });
  const { channel } = recorder({ ok: false, retryable: true, error: 'still failing' });

  let now = T0;
  for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
    const [claimed] = claimBatch(db, { now });
    assert.ok(claimed, `attempt ${i + 1} should find a claimable row`);
    const result = await deliverOne(db, claimed, { channels: { email: channel }, now });
    now = row(db, id).next_attempt || now;
    if (result.dead) break;
  }

  assert.equal(row(db, id).state, 'dead');
  assert.equal(row(db, id).attempts, MAX_ATTEMPTS);

  await db.close();
});

test('a message with no channel configured dies rather than retrying forever', async () => {
  // The failure mode this prevents: someone deploys without SMTP_HOST, and every
  // reminder silently retries until the attempt ceiling, days later.
  const db = await fresh();
  const id = queue(db, { channel: 'carrier-pigeon', now: T0 });

  const [claimed] = claimBatch(db, { now: T0 });
  const result = await deliverOne(db, claimed, { channels: {}, now: T0 });

  assert.equal(result.dead, true);
  assert.match(result.error, /no channel configured/i);
  assert.equal(row(db, id).state, 'dead');

  await db.close();
});

test('an adapter that throws does not take the batch down with it', async () => {
  // A buggy adapter is a bug, not a reason to strand every row behind it.
  const db = await fresh();
  const first = queue(db, { now: T0 });
  const second = queue(db, { now: T0 });

  const explosive = {
    name: 'email',
    supports: () => true,
    async send() { throw new Error('adapter exploded'); },
  };

  const result = await dispatch(db, { channels: { email: explosive }, now: T0 });

  assert.equal(result.attempted, 2, 'both rows must be attempted');
  assert.equal(result.sent, 0);
  assert.equal(row(db, first).state, 'queued', 'a throw is treated as retryable');
  assert.equal(row(db, second).state, 'queued');

  await db.close();
});

/* ── The pass as a whole ──────────────────────────────────────────────────── */

test('a dispatch pass sends everything that is due and nothing that is not', async () => {
  const db = await fresh();
  const due = queue(db, { now: T0 });
  const future = queue(db, { now: T0 });
  db.run('UPDATE outbox_message SET next_attempt = ? WHERE id = ?', [T0 + 86_400_000, future]);

  const { channel, sent } = recorder();
  const result = await dispatch(db, { channels: { email: channel }, now: T0 });

  assert.equal(result.attempted, 1);
  assert.equal(result.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(row(db, due).state, 'sent');
  assert.equal(row(db, future).state, 'queued');

  await db.close();
});

test('dispatch reports that nothing can send when no channel is configured', async () => {
  const db = await fresh();
  queue(db, { now: T0 });

  const result = await dispatch(db, { channels: {}, now: T0 });
  assert.equal(result.attempted, 0);
  assert.match(String(result.skipped), /no channels configured/i);

  // And crucially, the row is untouched — a missing channel must not burn an
  // attempt, or the message dies from a config mistake it never had a chance at.
  assert.equal(db.value("SELECT COUNT(*) FROM outbox_message WHERE state = 'queued'"), 1);

  await db.close();
});

/* ── Health ───────────────────────────────────────────────────────────────── */

test('outbox health answers "why is nothing sending"', async () => {
  const db = await fresh();
  queue(db, { now: T0 });
  const deadId = queue(db, { now: T0 });
  db.run("UPDATE outbox_message SET state = 'dead', attempts = 5, last_error = '401 unauthorised' WHERE id = ?", [deadId]);

  const health = outboxHealth(db, { now: T0 });

  assert.equal(health.byState.queued, 1);
  assert.equal(health.byState.dead, 1);
  assert.equal(health.dueNow, 1);
  assert.equal(health.stuck.length, 1);
  assert.equal(health.stuck[0].last_error, '401 unauthorised');
  assert.equal(health.oldestQueuedAt, T0);

  await db.close();
});

test('backoff grows and then stops growing', () => {
  assert.equal(backoffMs(1), 60_000);
  assert.equal(backoffMs(2), 120_000);
  assert.equal(backoffMs(3), 240_000);
  // The ceiling matters: a chaser that waits an hour between retries has stopped
  // chasing, and one that retries every ten seconds is a mail bomb.
  assert.equal(backoffMs(9), 16 * 60_000);
  assert.equal(backoffMs(50), 16 * 60_000);
});
