import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.mjs';
import { createClient, createInvoice, recordPayment, getInvoice } from '../src/domain.mjs';
import { selectPolicy, policySteps, stepTime, planInvoice, nextAction, applyPlan, shouldSkip } from '../src/policy.mjs';
import { tick, reconcile, claimDue, onPaymentRecorded, checkInvariants } from '../src/scheduler.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

async function scenario({ amountMinor = 50000000, issuedOn = T0, dueOn = T0 + 14 * DAY } = {}) {
  const db = await Db.open(':memory:');
  const clientId = createClient(db, {
    displayName: 'Ada Obi',
    handles: [{ channel: 'whatsapp', value: '08031234567' }],
    now: T0,
  });
  const invoiceId = createInvoice(db, {
    number: 'INV-001', clientId, currency: 'NGN', amountMinor, issuedOn, dueOn, now: T0,
  });
  return { db, clientId, invoiceId };
}

/* ------------------------------------------------------------------ policy */

test('the standard policy is selected for an ordinary invoice', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);
  const policy = selectPolicy(db, invoice);

  assert.equal(policy.name, 'standard');
  assert.equal(policy.version, 1);
});

test('a small invoice gets the small-balance policy', async () => {
  const { db, invoiceId } = await scenario({ amountMinor: 1000000 }); // ₦10,000
  const invoice = getInvoice(db, invoiceId);
  const policy = selectPolicy(db, invoice);

  assert.equal(policy.name, 'small-balance');
});

test('a policy with no steps yields no plan rather than crashing', async () => {
  const { db, invoiceId } = await scenario();
  db.run("UPDATE policy SET active = 0");

  const invoice = getInvoice(db, invoiceId);
  assert.equal(selectPolicy(db, invoice), null);
  assert.deepEqual(planInvoice(db, invoice).plan, []);
});

/* -------------------------------------------------------------- step timing */

test('a step fires at the right offset from its anchor', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);
  const steps = policySteps(db, 1);

  const headsUp = steps.find((step) => step.template_key === 'heads_up');
  assert.equal(stepTime(headsUp, { invoice }), invoice.due_on - 3 * DAY);

  const dueToday = steps.find((step) => step.template_key === 'due_today');
  assert.equal(stepTime(dueToday, { invoice }), invoice.due_on);
});

test('an unknown anchor is an error, not a silent zero', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  assert.throws(
    () => stepTime({ anchor: 'whenever', offset_days: 3 }, { invoice }),
    /unknown anchor/,
  );
});

/* ------------------------------------------------------------ skip logic */

test('a paid invoice skips every remaining step', async () => {
  const { db, clientId, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: invoice.amount_minor, receivedOn: T0,
    allocations: [{ invoiceId, amountMinor: invoice.amount_minor }], now: T0,
  });

  const refreshed = getInvoice(db, invoiceId);
  const { plan } = planInvoice(db, refreshed, { now: T0 + 20 * DAY });

  assert.ok(plan.every((entry) => entry.skipped));
  assert.ok(plan.every((entry) => entry.skipReason === 'already paid'));
});

test('an unknown halt condition skips rather than sending', async () => {
  // The dangerous failure is chasing someone who has paid. An unrecognised
  // rule must default to silence, not to action.
  const result = shouldSkip({ halt_if: 'something_new' }, { invoice: {}, paidMinor: 0, now: T0 });
  assert.equal(result, true);
});

/* --------------------------------------------------------------- planning */

test('the plan covers every step in order', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);
  const { plan } = planInvoice(db, invoice, { now: T0 });

  assert.equal(plan.length, 6);
  assert.deepEqual(plan.map((entry) => entry.position), [1, 2, 3, 4, 5, 6]);
});

test('planning is idempotent', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);
  const { plan } = planInvoice(db, invoice, { now: T0 });

  const first = applyPlan(db, invoice, plan, { now: T0 });
  const second = applyPlan(db, invoice, plan, { now: T0 });

  assert.equal(first.created, 6);
  assert.equal(second.created, 0);
  assert.equal(db.value('SELECT COUNT(*) AS n FROM reminder'), 6);
});

test('the next action is the earliest future step', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  const next = nextAction(db, invoice, { now: T0 });
  assert.equal(next.templateKey, 'heads_up');
  assert.equal(next.scheduledFor, invoice.due_on - 3 * DAY);
});

test('no next action once the invoice is paid', async () => {
  const { db, clientId, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: invoice.amount_minor, receivedOn: T0,
    allocations: [{ invoiceId, amountMinor: invoice.amount_minor }], now: T0,
  });

  assert.equal(nextAction(db, getInvoice(db, invoiceId), { now: T0 }), null);
});

/* -------------------------------------------------------------- scheduler */

test('a tick creates reminders and sends nothing before they are due', async () => {
  const { db } = await scenario();

  const result = tick(db, { now: T0 });
  assert.equal(result.created, 6);
  assert.equal(result.queued, 0);

  const outbox = db.value('SELECT COUNT(*) AS n FROM outbox_message');
  assert.equal(outbox, 0);
});

test('a tick on the due date sends one message, not the whole backlog', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  // Tick once at issue time so the reminders exist.
  tick(db, { now: T0 });

  // Then on the due date. Both heads_up and due_today are technically due, but
  // only the most advanced is sent — a client must never get two messages in
  // one minute.
  const result = tick(db, { now: invoice.due_on });

  assert.equal(result.queued, 1);
  assert.ok(result.superseded >= 1, 'the earlier step should be retired');

  const sent = db.rows('SELECT body FROM outbox_message ORDER BY id');
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.includes('INV-001'));
  assert.ok(sent[0].body.includes('due today'), 'the latest applicable message wins');
});

test('running the same tick twice does not double-send', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  tick(db, { now: T0 });
  tick(db, { now: invoice.due_on });
  const after = db.value('SELECT COUNT(*) AS n FROM outbox_message');

  tick(db, { now: invoice.due_on });
  const again = db.value('SELECT COUNT(*) AS n FROM outbox_message');

  assert.equal(after, again);
});

test('a payment between ticks stops the next message', async () => {
  const { db, clientId, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  tick(db, { now: T0 });

  // Pay in full before the due date.
  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: invoice.amount_minor,
    receivedOn: invoice.due_on - DAY,
    allocations: [{ invoiceId, amountMinor: invoice.amount_minor }],
    now: invoice.due_on - DAY,
  });

  const result = tick(db, { now: invoice.due_on + 30 * DAY });

  assert.equal(result.queued, 0, 'no message may be sent after payment');
});

test('a client with no address on file fails the reminder visibly', async () => {
  const db = await Db.open(':memory:');
  const clientId = createClient(db, { displayName: 'No Contact', now: T0 });
  const invoiceId = createInvoice(db, {
    number: 'INV-X', clientId, currency: 'NGN', amountMinor: 50000000,
    issuedOn: T0, dueOn: T0, now: T0,
  });

  tick(db, { now: T0 });
  tick(db, { now: T0 + 30 * DAY });

  const failed = db.rows("SELECT * FROM reminder WHERE state = 'failed'");
  assert.ok(failed.length > 0);
  assert.match(failed[0].failure, /no address/);
});

test('the message body carries the amount and the invoice number', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  tick(db, { now: T0 });
  tick(db, { now: invoice.due_on + 7 * DAY });

  const bodies = db.rows('SELECT body FROM outbox_message').map((row) => row.body);
  assert.ok(bodies.length > 0);

  for (const body of bodies) {
    assert.ok(body.includes('INV-001'), body);
    assert.ok(body.includes('Ada Obi'), body);
    assert.ok(body.includes('₦500,000.00'), body);
  }
});

test('a voided invoice is never chased', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  tick(db, { now: T0 });
  db.run("UPDATE invoice SET status = 'void', voided_at = ? WHERE id = ?", [T0, invoiceId]);

  const result = tick(db, { now: invoice.due_on + 10 * DAY });
  assert.equal(result.queued, 0);
});

/* ------------------------------------------------------- payment cancels */

test('recording a payment cancels the pending reminders for that client', async () => {
  const { db, clientId, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  tick(db, { now: T0 });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: invoice.amount_minor, receivedOn: T0,
    allocations: [{ invoiceId, amountMinor: invoice.amount_minor }], now: T0,
  });

  const cancelled = onPaymentRecorded(db, { clientId, currency: 'NGN', now: T0 });
  assert.ok(cancelled.cancelled > 0);

  const pending = db.value("SELECT COUNT(*) AS n FROM reminder WHERE state = 'pending'");
  assert.equal(pending, 0);
});

/* ------------------------------------------------------------- invariants */

test('invariants hold across a realistic sequence', async () => {
  const { db, clientId, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  tick(db, { now: T0 });
  tick(db, { now: invoice.due_on });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: 20000000, receivedOn: invoice.due_on,
    allocations: [{ invoiceId, amountMinor: 20000000 }], now: invoice.due_on,
  });

  tick(db, { now: invoice.due_on + 20 * DAY });

  const result = checkInvariants(db);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('a policy edit changes behaviour with no code change', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  // Move the gentle nudge from day 7 to day 2, in the data.
  db.run("UPDATE policy_step SET offset_days = 2 WHERE policy_id = 1 AND template_key = 'late_gentle'");

  const { plan } = planInvoice(db, invoice, { now: T0 });
  const gentle = plan.find((entry) => entry.templateKey === 'late_gentle');

  assert.equal(gentle.scheduledFor, invoice.due_on + 2 * DAY);
});

test('deactivating a policy removes its steps from new plans', async () => {
  const { db, invoiceId } = await scenario();
  const invoice = getInvoice(db, invoiceId);

  db.run('UPDATE policy SET active = 0');
  const { plan } = planInvoice(db, invoice, { now: T0 });

  assert.deepEqual(plan, []);
});
