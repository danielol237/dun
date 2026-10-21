// The scheduler is the money path, so it gets the hardest tests.
//
// Three things must be true no matter what the clock does:
//
//   1. It never sends a burst. A backdated invoice or a scheduler that was down
//      must not deliver a week of backlog at once — that reads as harassment
//      and costs the client who was going to pay anyway.
//   2. It never lies about the date. The wording follows the invoice's actual
//      state, and the record keeps the wording that was used, not the intent.
//   3. It never sends twice, and never keeps chasing money that has arrived.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.mjs';
import { createClient, createInvoice, recordPayment } from '../src/domain.mjs';
import { tick, reconcile, claimDue, onPaymentRecorded, checkInvariants } from '../src/scheduler.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 1);

async function fresh() {
  return Db.open(':memory:');
}

function client(db, name, whatsapp, now = T0) {
  return createClient(db, {
    displayName: name,
    handles: [{ channel: 'whatsapp', value: whatsapp }],
    now,
  });
}

function invoice(db, { number, clientId, amountMinor = 45000000, issuedOn, dueOn, now = T0 }) {
  return createInvoice(db, {
    number,
    clientId,
    currency: 'NGN',
    amountMinor,
    issuedOn,
    dueOn,
    now,
  });
}

const outbox = (db) =>
  db.rows('SELECT * FROM outbox_message ORDER BY id');

/* ------------------------------------------------------------- no bursts */

test('a six-week-late invoice does not deliver its whole backlog in one tick', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  // Issued and due long before the tick: every step in the sequence is overdue.
  const id = invoice(db, {
    number: 'INV-0001',
    clientId: ada,
    issuedOn: T0 - 50 * DAY,
    dueOn: T0 - 36 * DAY,
  });

  const result = tick(db, { now: T0 });

  assert.equal(result.queued, 1, 'exactly one message, not one per overdue step');
  assert.equal(outbox(db).length, 1);

  // Everything it skipped is recorded as superseded, not deleted.
  const superseded = db.value(
    "SELECT COUNT(*) FROM reminder WHERE invoice_id = ? AND state = 'superseded'",
    [id],
  );
  assert.ok(superseded >= 4, `expected several superseded, got ${superseded}`);
});

test('two invoices for one client produce one message per cooldown window', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 50 * DAY, dueOn: T0 - 36 * DAY });
  invoice(db, { number: 'INV-0002', clientId: ada, issuedOn: T0 - 40 * DAY, dueOn: T0 - 26 * DAY });

  const result = tick(db, { now: T0 });

  assert.equal(result.queued, 1, 'one message to Ada, not one per invoice');
  assert.equal(outbox(db).length, 1);
});

test('different clients are not blocked by each other', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');
  const chinedu = client(db, 'Chinedu Eze', '08039998877');

  invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 50 * DAY, dueOn: T0 - 36 * DAY });
  invoice(db, { number: 'INV-0002', clientId: chinedu, issuedOn: T0 - 50 * DAY, dueOn: T0 - 36 * DAY });

  const result = tick(db, { now: T0 });

  assert.equal(result.queued, 2);
  assert.equal(new Set(outbox(db).map((m) => m.recipient)).size, 2);
});

/* ----------------------------------------------------------- no lying */

test('a late-claimed due-date step is worded for the real state', async () => {
  const db = await fresh();
  const chinedu = client(db, 'Chinedu Eze', '08039998877');

  const id = invoice(db, {
    number: 'INV-0002',
    clientId: chinedu,
    issuedOn: T0 - 30 * DAY,
    dueOn: T0 - 6 * DAY,
  });

  tick(db, { now: T0 });

  const [message] = outbox(db);
  assert.equal(message.body.includes('due today'), false, message.body);
  assert.ok(message.body.includes('6 days ago'), message.body);

  // The record must agree with the body, not with the step that produced it.
  const sent = db.row(
    'SELECT template_key, rendered_template_key FROM reminder WHERE invoice_id = ? AND sent_at IS NOT NULL',
    [id],
  );
  assert.notEqual(sent.rendered_template_key, 'due_today');
  assert.equal(sent.rendered_template_key, 'late_gentle');
});

test('an invoice actually due today still says so', async () => {
  const db = await fresh();
  const tunde = client(db, 'Tunde Bakare', '07066554433');

  invoice(db, { number: 'INV-0004', clientId: tunde, issuedOn: T0 - 14 * DAY, dueOn: T0 });

  tick(db, { now: T0 });

  const [message] = outbox(db);
  assert.ok(message.body.includes('due today'), message.body);
});

test('the message quotes what is still owed, not the original amount', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  const id = invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 40 * DAY, dueOn: T0 - 20 * DAY });

  recordPayment(db, {
    clientId: ada,
    currency: 'NGN',
    amountMinor: 15000000,
    receivedOn: T0 - 10 * DAY,
    allocations: [{ invoiceId: id, amountMinor: 15000000 }],
    now: T0 - 10 * DAY,
  });

  tick(db, { now: T0 });

  const [message] = outbox(db);
  assert.ok(message.body.includes('300,000'), message.body);
  assert.equal(message.body.includes('450,000'), false, message.body);
});

/* --------------------------------------------------------- idempotence */

test('ticking twice sends nothing twice', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 50 * DAY, dueOn: T0 - 36 * DAY });

  const first = tick(db, { now: T0 });
  const second = tick(db, { now: T0 });

  assert.equal(first.queued, 1);
  assert.equal(second.queued, 0);
  assert.equal(outbox(db).length, 1);
});

test('reconciling repeatedly does not duplicate reminders', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 50 * DAY, dueOn: T0 - 36 * DAY });

  reconcile(db, { now: T0 });
  const after1 = db.value('SELECT COUNT(*) FROM reminder');
  reconcile(db, { now: T0 });
  reconcile(db, { now: T0 });

  assert.equal(db.value('SELECT COUNT(*) FROM reminder'), after1);
});

/* ------------------------------------------------------------- payments */

test('paying in full stops the chase', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  const id = invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 40 * DAY, dueOn: T0 - 20 * DAY });

  tick(db, { now: T0 });
  const before = outbox(db).length;

  recordPayment(db, {
    clientId: ada,
    currency: 'NGN',
    amountMinor: 45000000,
    receivedOn: T0,
    allocations: [{ invoiceId: id, amountMinor: 45000000 }],
    now: T0,
  });

  onPaymentRecorded(db, { clientId: ada, currency: 'NGN', now: T0 });

  const result = tick(db, { now: T0 + DAY });

  assert.equal(result.queued, 0);
  assert.equal(outbox(db).length, before, 'no new message after payment');

  const pending = db.value(
    "SELECT COUNT(*) FROM reminder WHERE invoice_id = ? AND state = 'pending'",
    [id],
  );
  assert.equal(pending, 0);
});

test('a partially paid invoice keeps chasing the remainder', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  const id = invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 40 * DAY, dueOn: T0 - 20 * DAY });

  recordPayment(db, {
    clientId: ada,
    currency: 'NGN',
    amountMinor: 10000000,
    receivedOn: T0,
    allocations: [{ invoiceId: id, amountMinor: 10000000 }],
    now: T0,
  });

  onPaymentRecorded(db, { clientId: ada, currency: 'NGN', now: T0 });
  const result = tick(db, { now: T0 });

  assert.equal(result.queued, 1, 'still owes ₦350,000, so the chase continues');
});

/* ------------------------------------------------------------- policies */

test('a small invoice uses the small-balance policy', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  // ₦20,000 — under the small-balance ceiling.
  invoice(db, { number: 'INV-0001', clientId: ada, amountMinor: 2000000, issuedOn: T0 - 40 * DAY, dueOn: T0 - 20 * DAY });

  reconcile(db, { now: T0 });

  const policy = db.row(
    `SELECT p.name FROM policy_assignment pa
       JOIN policy p ON p.id = pa.policy_id`,
  );
  assert.equal(policy.name, 'small-balance');
});

test('a large invoice uses the standard policy', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  invoice(db, { number: 'INV-0001', clientId: ada, amountMinor: 45000000, issuedOn: T0 - 40 * DAY, dueOn: T0 - 20 * DAY });

  reconcile(db, { now: T0 });

  const policy = db.row(
    `SELECT p.name FROM policy_assignment pa JOIN policy p ON p.id = pa.policy_id`,
  );
  assert.equal(policy.name, 'standard');
});

/* --------------------------------------------------------------- guardrails */

test('the internal flag template never reaches the outbox', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  // 50 days late: past the flag step at 45 days.
  invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 70 * DAY, dueOn: T0 - 50 * DAY });

  tick(db, { now: T0 });

  for (const message of outbox(db)) {
    assert.equal(message.body.includes('No automatic follow-up'), false, message.body);
  }

  const flagged = db.value(
    "SELECT COUNT(*) FROM reminder WHERE template_key = 'late_flag' AND state = 'sent'",
  );
  assert.ok(flagged >= 1, 'the flag is recorded internally');
});

test('a client with no address on file fails visibly instead of silently', async () => {
  const db = await fresh();
  const ada = createClient(db, { displayName: 'Ada Obi', handles: [], now: T0 });

  invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 50 * DAY, dueOn: T0 - 36 * DAY });

  const result = tick(db, { now: T0 });

  assert.equal(result.queued, 0);
  const failed = db.value("SELECT COUNT(*) FROM reminder WHERE state = 'failed'");
  assert.ok(failed >= 1);
});

test('the ledger stays balanced through a full cycle', async () => {
  const db = await fresh();
  const ada = client(db, 'Ada Obi', '08031234567');

  const id = invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 - 40 * DAY, dueOn: T0 - 20 * DAY });

  tick(db, { now: T0 });

  recordPayment(db, {
    clientId: ada,
    currency: 'NGN',
    amountMinor: 20000000,
    receivedOn: T0,
    allocations: [{ invoiceId: id, amountMinor: 20000000 }],
    now: T0,
  });

  tick(db, { now: T0 + DAY });

  const check = checkInvariants(db);
  assert.equal(check.ok, true, JSON.stringify(check));
});

/* --------------------------------------------------------------- claiming */

test('claiming respects the batch limit', async () => {
  const db = await fresh();

  for (let i = 0; i < 5; i += 1) {
    const id = client(db, `Client ${i}`, `0803123456${i}`);
    invoice(db, {
      number: `INV-000${i}`,
      clientId: id,
      issuedOn: T0 - 50 * DAY,
      dueOn: T0 - 36 * DAY,
    });
  }

  reconcile(db, { now: T0 });
  const result = claimDue(db, { now: T0, limit: 2 });

  assert.ok(result.queued <= 2, `queued ${result.queued} with limit 2`);
});
