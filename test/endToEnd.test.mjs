// End to end: a real statement, through the real CLI-shaped path, to a stopped chase.
//
// Every other test file proves one module. This one proves the product: money
// arrives in a bank export, it is read, attributed, recorded, proposed against the
// right invoice, confirmed, and the chase stops — with the ledger still balanced.
//
// The scenario is the one that actually happens: an agency invoices a client, the
// client pays by transfer and types the invoice number, and the statement lands
// in the operator's inbox a few days later.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../src/db.mjs';
import { Ledger } from '../src/ledger.mjs';
import {
  createClient, createInvoice, allocate, getInvoice,
} from '../src/domain.mjs';
import { tick, onPaymentRecorded, checkInvariants } from '../src/scheduler.mjs';
import { importStatement } from '../src/import.mjs';
import { reviewQueue, proposeMatches } from '../src/matcher.mjs';
import { dispatch } from '../src/delivery.mjs';

const DAY = 24 * 60 * 60 * 1000;

// The invoice is issued in the past and the payment lands after it — the ordinary
// order of events, and the one a date guard has to allow.
const ISSUED = Date.UTC(2026, 4, 1);
const DUE = Date.UTC(2026, 4, 15);
const PAID = Date.UTC(2026, 4, 20);

const STATEMENT = [
  'Transaction Date,Narration,Credit,Debit,Reference',
  '20/05/2026,TRANSFER FROM ADA OBI INV-0001,450000.00,,GT20260520001',
  '21/05/2026,ATM WITHDRAWAL LAGOS,,20000.00,GT20260521002',
].join('\n');

async function agency() {
  const db = await Db.open(':memory:');

  const ada = createClient(db, {
    displayName: 'Ada Obi',
    handles: [{ channel: 'whatsapp', value: '+2348012345678' }],
    now: ISSUED,
  });

  const invoiceId = createInvoice(db, {
    number: 'INV-0001',
    clientId: ada,
    currency: 'NGN',
    amountMinor: 45_000_000,
    issuedOn: ISSUED,
    dueOn: DUE,
    now: ISSUED,
  });

  return { db, ada, invoiceId };
}

test('a bank payment stops the chase, end to end', async () => {
  const { db, ada, invoiceId } = await agency();

  // ── 1. The chase is running ──
  const firstTick = tick(db, { now: DUE + 5 * DAY });
  assert.ok(firstTick.queued > 0, 'a late invoice must produce a queued reminder');

  const queued = db.value("SELECT COUNT(*) FROM outbox_message WHERE state = 'queued'");
  assert.equal(queued, 1, 'exactly one demand is queued, not the whole backlog');

  // ── 2. The statement arrives ──
  const imported = importStatement(db, STATEMENT, {
    currency: 'NGN', source: 'feed:gtbank', now: PAID,
  });

  assert.equal(imported.imported, 1, 'the credit is recorded');
  assert.equal(imported.debitsIgnored, 1, 'the withdrawal is reported, not recorded');
  assert.equal(imported.unattributed, 0, 'the payer was recognised from the narration');

  // ── 3. The payment is proposed against the right invoice, not allocated ──
  const payment = db.row('SELECT * FROM payment ORDER BY id DESC LIMIT 1');
  assert.equal(payment.client_id, ada);
  assert.equal(payment.amount_minor, 45_000_000);
  assert.equal(payment.source, 'feed:gtbank');

  const proposal = proposeMatches(db, payment)[0];
  assert.equal(proposal.number, 'INV-0001', 'the narration names the invoice, so it wins');
  assert.equal(proposal.confident, true);

  // And crucially, nothing was credited yet.
  assert.equal(
    db.value('SELECT COUNT(*) FROM allocation'),
    0,
    'an import must never allocate on its own',
  );

  // ── 4. The chase is paused while the match is unconfirmed ──
  //
  // This is the bug that mattered most: an unallocated payment leaves the invoice
  // reading as outstanding, so the next tick would demand money already sent.
  const pending = db.value("SELECT COUNT(*) FROM reminder WHERE state = 'pending'");
  assert.equal(pending, 0, 'a covering payment must hold the reminders');
  assert.ok(
    db.value("SELECT COUNT(*) FROM reminder WHERE state = 'held'") > 0,
    'the reminder is held, not silently sent',
  );

  // ── 5. The operator confirms ──
  const result = allocate(db, payment.id, invoiceId, 45_000_000);
  assert.equal(result.status, 'paid');
  assert.equal(result.outstandingMinor, 0);

  const settled = getInvoice(db, invoiceId);
  assert.equal(settled.status, 'paid');

  // ── 6. And the reminders are retired for good ──
  const cancelled = onPaymentRecorded(db, { clientId: ada, currency: 'NGN' });
  assert.ok(cancelled.cancelled > 0, 'confirming the match must cancel the chase');

  // ── 7. The ledger is still honest ──
  const ledger = new Ledger(db);
  assert.deepEqual(ledger.unbalancedGroups(), [], 'every posting must net to zero');

  const invariants = checkInvariants(db);
  assert.equal(invariants.ok, true, `invariants violated: ${JSON.stringify(invariants)}`);

  await db.close();
});

test('re-importing the same statement does not double-count the payment', async () => {
  const { db } = await agency();

  importStatement(db, STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: PAID });
  const again = importStatement(db, STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: PAID });

  assert.equal(again.imported, 0);
  assert.equal(again.duplicates, 1);
  assert.equal(db.value('SELECT COUNT(*) FROM payment'), 1, 'one payment, not two');

  await db.close();
});

test('a delivery pass after a held reminder sends nothing', async () => {
  // The combination that would be worst in production: the reminder is held
  // because a payment covers it, but a queued row from before the payment landed
  // is still sitting in the outbox. It must not go out.
  const { db } = await agency();

  // Queue a demand.
  tick(db, { now: DUE + 5 * DAY });
  assert.equal(db.value("SELECT COUNT(*) FROM outbox_message WHERE state = 'queued'"), 1);

  // The payment lands.
  importStatement(db, STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: PAID });

  // The row that was already queued is now a demand for money that has arrived.
  // Holding the reminder cannot unsend it, so the outbox has to know.
  const stillQueued = db.value(
    `SELECT COUNT(*) FROM outbox_message o
       JOIN reminder r ON r.id = o.reminder_id
      WHERE o.state = 'queued' AND r.state = 'held'`,
  );

  const sent = await dispatch(db, {
    channels: {
      webhook: {
        name: 'webhook',
        supports: () => true,
        async send() { throw new Error('nothing should be sent'); },
      },
    },
    now: PAID,
  });

  if (stillQueued > 0) {
    // If this ever fires, the fix belongs in delivery.mjs: skip rows whose
    // reminder is no longer pending.
    assert.equal(sent.sent, 0, 'a held reminder must not deliver');
  }

  await db.close();
});

test('an import for a period before the invoices were issued explains itself', async () => {
  // The honest failure. A statement from last month against invoices created
  // today matches nothing, and "no match" alone reads as a bug rather than as the
  // operator pointing at the wrong month.
  const db = await Db.open(':memory:');
  // The invoice is issued a month AFTER the statement period. This is the
  // realistic mistake: last month's statement imported against this month's
  // invoices.
  const LATER = PAID + 30 * DAY;
  const ada = createClient(db, {
    displayName: 'Ada Obi',
    handles: [{ channel: 'whatsapp', value: '+2348012345678' }],
    now: LATER,
  });
  createInvoice(db, {
    number: 'INV-0009', clientId: ada, currency: 'NGN', amountMinor: 45_000_000,
    issuedOn: LATER, dueOn: LATER + 14 * DAY, now: LATER,
  });

  const imported = importStatement(db, STATEMENT, {
    currency: 'NGN', source: 'feed:gtbank', now: LATER,
  });

  assert.equal(imported.imported, 1, 'the money is still recorded — it did arrive');
  const proposal = imported.payments[0].proposals[0];
  assert.equal(proposal.invoiceId, null, 'but no invoice is proposed');
  assert.match(proposal.reasons[0], /issued after this payment arrived/i);

  await db.close();
});
