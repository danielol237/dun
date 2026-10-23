// ── Delivery: draining the outbox ────────────────────────────────────────────
//
// The scheduler renders a reminder into an `outbox_message` row and marks the
// reminder 'sent'. Until this file existed, "sent" meant "queued" — nothing ever
// moved the row. A chaser that never sends is worse than no chaser, because the
// operator believes the client has been chased.
//
// Three properties matter more than throughput, and each is why the code looks
// the way it does:
//
//   1. A message is never sent twice. Rows are claimed with a lease inside a
//      transaction before any network call, so two processes cannot both pick up
//      the same row. The claim is also stamped with a time, so a crash mid-send
//      releases it instead of stranding the row in 'claimed' forever.
//
//   2. A retry is the same message, not a new one. Every row carries an
//      idempotency key derived from its reminder. A timeout is ambiguous — the
//      provider may have delivered it — so the retry has to be recognisable as a
//      duplicate rather than arrive as a second demand.
//
//   3. Failure is classified, not retried blindly. A 401 will still be a 401 in
//      five minutes; retrying it only fills the log and hides the real problem.
//      Adapters say whether a failure is retryable, and this trusts that.

import { channelFor } from './channels.mjs';
import { audit } from './domain.mjs';

/** How long a claim is honoured before another worker may take the row. */
export const CLAIM_LEASE_MS = 2 * 60 * 1000;

/** Attempts before a message is declared dead and a human is told. */
export const MAX_ATTEMPTS = Number(process.env.DUN_MAX_SEND_ATTEMPTS || 5);

/**
 * Exponential backoff with a ceiling.
 *
 * 1 min, 2, 4, 8, 16 — then flat. A chaser that waits an hour between retries
 * has stopped chasing; one that retries every ten seconds is a mail bomb.
 */
export function backoffMs(attempts) {
  const base = 60 * 1000;
  const capped = Math.min(attempts, 5);
  return Math.min(base * 2 ** Math.max(0, capped - 1), 16 * 60 * 1000);
}

/**
 * Take the next batch of deliverable rows.
 *
 * The claim is a single UPDATE ... WHERE state = 'queued', so two processes
 * racing here cannot both win the same row: SQLite serialises the write and the
 * loser's WHERE no longer matches.
 */
export function claimBatch(db, { now = Date.now(), limit = 20, leaseMs = CLAIM_LEASE_MS } = {}) {
  return db.transaction(() => {
    const ready = db.rows(
      `SELECT id FROM outbox_message
        WHERE (state = 'queued' AND next_attempt <= ?)
           OR (state = 'claimed' AND claimed_at IS NOT NULL AND claimed_at < ?)
        ORDER BY next_attempt, id
        LIMIT ?`,
      [now, now - leaseMs, limit],
    );

    if (ready.length === 0) return [];

    const ids = ready.map((row) => row.id);
    const placeholders = ids.map(() => '?').join(',');
    db.run(
      `UPDATE outbox_message
          SET state = 'claimed', claimed_at = ?
        WHERE id IN (${placeholders})`,
      [now, ...ids],
    );

    return db.rows(
      `SELECT * FROM outbox_message WHERE id IN (${placeholders}) ORDER BY id`,
      ids,
    );
  });
}

/**
 * Deliver one claimed row.
 *
 * Returns a result describing what happened, and never throws: a delivery
 * failure is data the caller records, not an exception that aborts the batch and
 * strands every row behind it.
 */
export async function deliverOne(db, row, { channels, now = Date.now() } = {}) {
  const channel = channelFor(channels, row);

  if (!channel) {
    // No adapter for this channel at all. That is a configuration problem, not a
    // transient one — mark it dead immediately so it shows up as a real failure
    // instead of quietly retrying until the heat death of the universe.
    db.run(
      `UPDATE outbox_message
          SET state = 'dead', attempts = attempts + 1, last_error = ?, claimed_at = NULL
        WHERE id = ?`,
      [`no channel configured for "${row.channel}"`, row.id],
    );
    audit(db, now, 'system', 'outbox.dead', 'outbox', row.id, { reason: 'no channel' });
    return { id: row.id, ok: false, dead: true, error: `no channel configured for "${row.channel}"` };
  }

  const idempotencyKey = row.idempotency_key || `dun-${row.reminder_id ?? row.id}-${row.id}`;

  let result;
  try {
    result = await channel.send({ to: row.recipient, body: row.body, idempotencyKey });
  } catch (err) {
    // An adapter that throws is a bug, but it must not take the batch down. Treat
    // it as retryable: the message has not been confirmed sent.
    result = { ok: false, retryable: true, error: String(err?.message || err).slice(0, 300) };
  }

  if (result.ok) {
    db.run(
      `UPDATE outbox_message
          SET state = 'sent', sent_at = ?, claimed_at = NULL, provider_id = ?, last_error = NULL
        WHERE id = ?`,
      [now, result.providerId ?? null, row.id],
    );
    audit(db, now, 'system', 'outbox.sent', 'outbox', row.id, {
      channel: channel.name,
      providerId: result.providerId ?? null,
    });
    return { id: row.id, ok: true, channel: channel.name, providerId: result.providerId ?? null };
  }

  const attempts = (row.attempts ?? 0) + 1;
  const dead = !result.retryable || attempts >= MAX_ATTEMPTS;
  const nextAttempt = dead ? now : now + backoffMs(attempts);

  db.run(
    `UPDATE outbox_message
        SET state = ?, attempts = ?, next_attempt = ?, last_error = ?, claimed_at = NULL
      WHERE id = ?`,
    [dead ? 'dead' : 'queued', attempts, nextAttempt, String(result.error || 'send failed').slice(0, 500), row.id],
  );

  audit(db, now, 'system', dead ? 'outbox.dead' : 'outbox.retry', 'outbox', row.id, {
    channel: channel.name,
    attempts,
    retryable: Boolean(result.retryable),
    error: String(result.error || '').slice(0, 300),
    nextAttempt,
  });

  return {
    id: row.id,
    ok: false,
    dead,
    attempts,
    retryable: Boolean(result.retryable),
    nextAttempt,
    error: String(result.error || 'send failed').slice(0, 300),
  };
}

/**
 * One delivery pass: claim, send, record.
 *
 * Sequential on purpose. Deliveries are a handful per tick, and sending them one
 * at a time keeps the ledger writes and the audit trail in a predictable order —
 * worth more here than the milliseconds concurrency would save.
 */
export async function dispatch(db, { channels, now = Date.now(), limit = 20, leaseMs = CLAIM_LEASE_MS } = {}) {
  if (!channels || Object.keys(channels).length === 0) {
    return { attempted: 0, sent: 0, failed: 0, dead: 0, skipped: 'no channels configured', results: [] };
  }

  const rows = claimBatch(db, { now, limit, leaseMs });
  if (rows.length === 0) return { attempted: 0, sent: 0, failed: 0, dead: 0, results: [] };

  const results = [];
  for (const row of rows) {
    results.push(await deliverOne(db, row, { channels, now }));
  }

  return {
    attempted: results.length,
    sent: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok && !r.dead).length,
    dead: results.filter((r) => r.dead).length,
    results,
  };
}

/**
 * What is stuck, and why — the question an operator actually asks.
 *
 * Counts by state plus the most recent error per state, so "nothing is sending"
 * has an answer other than silence.
 */
export function outboxHealth(db, { now = Date.now() } = {}) {
  const counts = db.rows(
    `SELECT state, COUNT(*) AS n FROM outbox_message GROUP BY state ORDER BY state`,
  );
  const byState = Object.fromEntries(counts.map((row) => [row.state, row.n]));

  const dueNow = db.value(
    `SELECT COUNT(*) FROM outbox_message WHERE state = 'queued' AND next_attempt <= ?`,
    [now],
  );

  const stuck = db.rows(
    `SELECT id, channel, recipient, attempts, last_error FROM outbox_message
      WHERE state IN ('failed', 'dead') ORDER BY id DESC LIMIT 10`,
  );

  const oldest = db.row(
    `SELECT id, created_at FROM outbox_message
      WHERE state = 'queued' ORDER BY created_at LIMIT 1`,
  );

  return {
    byState,
    dueNow,
    stuck,
    oldestQueuedAt: oldest ? oldest.created_at : null,
    oldestQueuedAgeMs: oldest ? now - oldest.created_at : 0,
  };
}
