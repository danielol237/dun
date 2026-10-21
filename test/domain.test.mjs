import test from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/db.mjs';
import { Ledger, ACCOUNTS } from '../src/ledger.mjs';
import {
  createClient,
  createInvoice,
  getInvoice,
  recordPayment,
  voidInvoice,
  openInvoices,
  normaliseHandle,
  findPartyByHandle,
} from '../src/domain.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

async function fresh() {
  const db = await Db.open(':memory:');
  return db;
}

/* ------------------------------------------------------------------ parties */

test('a client is created with normalised handles', async () => {
  const db = await fresh();
  const id = createClient(db, {
    displayName: 'Ada Obi',
    handles: [
      { channel: 'whatsapp', value: '08031234567' },
      { channel: 'email', value: 'Ada@Example.COM' },
    ],
    now: T0,
  });

  const handles = db.rows('SELECT channel, value FROM party_handle WHERE party_id = ? ORDER BY channel', [id]);
  assert.deepEqual(handles, [
    { channel: 'email', value: 'ada@example.com' },
    { channel: 'whatsapp', value: '+2348031234567' },
  ]);
});

test('local and international Nigerian numbers resolve to the same party', async () => {
  const db = await fresh();
  const id = createClient(db, {
    displayName: 'Ada',
    handles: [{ channel: 'whatsapp', value: '08031234567' }],
    now: T0,
  });

  const found = findPartyByHandle(db, 'whatsapp', '+2348031234567');
  assert.equal(found.id, id);
  assert.equal(findPartyByHandle(db, 'whatsapp', '2348031234567').id, id);
});

test('handles are unique per channel', async () => {
  const db = await fresh();
  createClient(db, { displayName: 'A', handles: [{ channel: 'whatsapp', value: '08031234567' }], now: T0 });

  assert.throws(
    () => createClient(db, { displayName: 'B', handles: [{ channel: 'whatsapp', value: '+2348031234567' }], now: T0 }),
    /UNIQUE|constraint/i,
  );
});

test('invalid handles are refused', () => {
  assert.throws(() => normaliseHandle('email', 'not-an-email'), /invalid email/);
  assert.throws(() => normaliseHandle('whatsapp', '123'), /invalid phone/);
  assert.throws(() => normaliseHandle('carrier-pigeon', 'x'), /unknown channel/);
});

/* ----------------------------------------------------------------- invoices */

test('an invoice books a receivable against revenue', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  const invoiceId = createInvoice(db, {
    number: 'INV-001',
    clientId,
    currency: 'NGN',
    amountMinor: 50000000, // ₦500,000
    issuedOn: T0,
    dueOn: T0 + 14 * DAY,
    now: T0,
  });

  const invoice = getInvoice(db, invoiceId);
  assert.equal(invoice.amount_minor, 50000000);
  assert.equal(invoice.outstandingMinor, 50000000);
  assert.equal(invoice.status, 'open');

  const ledger = new Ledger(db);
  const entries = ledger.entriesFor('invoice', invoiceId);

  assert.equal(entries.length, 2);
  assert.equal(entries.find((e) => e.account === ACCOUNTS.RECEIVABLE).debit_minor, 50000000);
  assert.equal(entries.find((e) => e.account === ACCOUNTS.REVENUE).credit_minor, 50000000);
});

test('invoice numbers are unique', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  const base = { clientId, currency: 'NGN', amountMinor: 1000, issuedOn: T0, dueOn: T0, now: T0 };
  createInvoice(db, { ...base, number: 'INV-1' });

  assert.throws(() => createInvoice(db, { ...base, number: 'INV-1' }), /UNIQUE|constraint/i);
});

test('an invoice cannot be addressed to yourself', async () => {
  const db = await fresh();
  // The seed creates party id 1 as 'self'.
  assert.throws(
    () => createInvoice(db, { number: 'X', clientId: 1, currency: 'NGN', amountMinor: 100, issuedOn: T0, dueOn: T0 }),
    /client/,
  );
});

test('an invoice cannot be due before it is issued', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  assert.throws(
    () => createInvoice(db, {
      number: 'INV-X', clientId, currency: 'NGN', amountMinor: 100,
      issuedOn: T0 + DAY, dueOn: T0,
    }),
    /due date cannot precede/,
  );
});

test('a zero or negative invoice is refused', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  for (const amountMinor of [0, -100]) {
    assert.throws(
      () => createInvoice(db, { number: `N${amountMinor}`, clientId, currency: 'NGN', amountMinor, issuedOn: T0, dueOn: T0 }),
      /positive amount/,
    );
  }
});

/* ----------------------------------------------------------------- payments */

test('a payment books cash against receivable and settles the invoice', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  const invoiceId = createInvoice(db, {
    number: 'INV-001', clientId, currency: 'NGN', amountMinor: 50000000,
    issuedOn: T0, dueOn: T0 + 14 * DAY, now: T0,
  });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: 50000000, receivedOn: T0 + 10 * DAY,
    allocations: [{ invoiceId, amountMinor: 50000000 }], now: T0 + 10 * DAY,
  });

  const invoice = getInvoice(db, invoiceId);
  assert.equal(invoice.status, 'paid');
  assert.equal(invoice.outstandingMinor, 0);

  const ledger = new Ledger(db);
  assert.deepEqual(ledger.outstandingByClient(clientId), [], 'nothing should be outstanding');
});

test('a partial payment leaves the invoice part-paid', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  const invoiceId = createInvoice(db, {
    number: 'INV-001', clientId, currency: 'NGN', amountMinor: 50000000,
    issuedOn: T0, dueOn: T0, now: T0,
  });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: 20000000, receivedOn: T0,
    allocations: [{ invoiceId, amountMinor: 20000000 }], now: T0,
  });

  const invoice = getInvoice(db, invoiceId);
  assert.equal(invoice.status, 'part_paid');
  assert.equal(invoice.outstandingMinor, 30000000);
});

test('one payment can settle several invoices', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  const a = createInvoice(db, { number: 'A', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });
  const b = createInvoice(db, { number: 'B', clientId, currency: 'NGN', amountMinor: 250000, issuedOn: T0, dueOn: T0, now: T0 });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: 350000, receivedOn: T0,
    allocations: [
      { invoiceId: a, amountMinor: 100000 },
      { invoiceId: b, amountMinor: 250000 },
    ],
    now: T0,
  });

  assert.equal(getInvoice(db, a).status, 'paid');
  assert.equal(getInvoice(db, b).status, 'paid');
});

test('an over-allocation is refused', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });
  const invoiceId = createInvoice(db, { number: 'A', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });

  assert.throws(
    () => recordPayment(db, {
      clientId, currency: 'NGN', amountMinor: 200000, receivedOn: T0,
      allocations: [{ invoiceId, amountMinor: 200000 }], now: T0,
    }),
    /exceeds outstanding/,
  );
});

test('allocations cannot exceed the payment itself', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });
  const invoiceId = createInvoice(db, { number: 'A', clientId, currency: 'NGN', amountMinor: 500000, issuedOn: T0, dueOn: T0, now: T0 });

  assert.throws(
    () => recordPayment(db, {
      clientId, currency: 'NGN', amountMinor: 100000, receivedOn: T0,
      allocations: [{ invoiceId, amountMinor: 200000 }], now: T0,
    }),
    /allocations exceed the payment amount/,
  );
});

test('a payment cannot be allocated across currencies', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });
  const ngn = createInvoice(db, { number: 'N', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });
  const usd = createInvoice(db, { number: 'U', clientId, currency: 'USD', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });

  assert.throws(
    () => recordPayment(db, {
      clientId, currency: 'USD', amountMinor: 100000, receivedOn: T0,
      allocations: [{ invoiceId: ngn, amountMinor: 100000 }], now: T0,
    }),
    /across currencies/,
  );

  assert.ok(getInvoice(db, usd));
});

test('an unallocated payment sits as a credit, not a mystery', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  recordPayment(db, { clientId, currency: 'NGN', amountMinor: 500000, receivedOn: T0, now: T0 });

  const ledger = new Ledger(db);
  const outstanding = ledger.outstandingByClient(clientId);

  // Receivable was credited without a matching debit, so the client is in
  // credit. Negative balance is the correct, visible representation.
  assert.equal(outstanding.length, 1);
  assert.equal(outstanding[0].balance_minor, -500000);
});

/* -------------------------------------------------------------------- voids */

test('voiding reverses the receivable and keeps the history', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });
  const invoiceId = createInvoice(db, { number: 'A', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });

  voidInvoice(db, invoiceId, { reason: 'raised in error', now: T0 + DAY });

  const invoice = getInvoice(db, invoiceId);
  assert.equal(invoice.status, 'void');

  const ledger = new Ledger(db);
  assert.deepEqual(ledger.outstandingByClient(clientId), []);

  const entries = db.rows('SELECT cause_kind FROM ledger_entry WHERE cause_id = ? ORDER BY id', [invoiceId]);
  assert.deepEqual(entries.map((e) => e.cause_kind), ['invoice', 'invoice', 'reversal', 'reversal']);
});

test('an invoice with payments cannot be voided', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });
  const invoiceId = createInvoice(db, { number: 'A', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: 50000, receivedOn: T0,
    allocations: [{ invoiceId, amountMinor: 50000 }], now: T0,
  });

  assert.throws(() => voidInvoice(db, invoiceId), /payments allocated/);
});

/* --------------------------------------------------------------- invariants */

test('the ledger balances after every operation', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  const a = createInvoice(db, { number: 'A', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });
  const b = createInvoice(db, { number: 'B', clientId, currency: 'NGN', amountMinor: 250000, issuedOn: T0, dueOn: T0, now: T0 });
  const c = createInvoice(db, { number: 'C', clientId, currency: 'NGN', amountMinor: 90000, issuedOn: T0, dueOn: T0, now: T0 });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: 150000, receivedOn: T0,
    allocations: [{ invoiceId: a, amountMinor: 100000 }, { invoiceId: b, amountMinor: 50000 }],
    now: T0,
  });

  // Only an invoice with no payments against it can be voided.
  voidInvoice(db, c, { now: T0 });

  const ledger = new Ledger(db);
  assert.deepEqual(ledger.unbalancedGroups(), []);

  for (const row of ledger.trialBalance()) {
    assert.equal(row.debits, row.credits, `currency ${row.currency}`);
  }
});

test('a ledger posting cannot debit and credit the same account', async () => {
  const db = await fresh();
  const ledger = new Ledger(db);

  assert.throws(
    () => ledger.post({
      causeKind: 'adjustment', amountMinor: 100, currency: 'NGN',
      debitAccount: 'cash', creditAccount: 'cash',
    }),
    /same account/,
  );
});

test('a ledger posting cannot be zero or negative', async () => {
  const db = await fresh();
  const ledger = new Ledger(db);

  for (const amountMinor of [0, -1, 1.5]) {
    assert.throws(
      () => ledger.post({
        causeKind: 'adjustment', amountMinor, currency: 'NGN',
        debitAccount: 'cash', creditAccount: 'revenue',
      }),
      /positive integer/,
    );
  }
});

test('open invoices exclude paid and voided ones', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });

  const open = createInvoice(db, { number: 'OPEN', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });
  const paid = createInvoice(db, { number: 'PAID', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });
  const voided = createInvoice(db, { number: 'VOID', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });

  recordPayment(db, {
    clientId, currency: 'NGN', amountMinor: 100000, receivedOn: T0,
    allocations: [{ invoiceId: paid, amountMinor: 100000 }], now: T0,
  });
  voidInvoice(db, voided, { now: T0 });

  const queue = openInvoices(db, { now: T0 });
  assert.deepEqual(queue.map((i) => i.number), ['OPEN']);
  assert.equal(queue[0].id, open);
});

test('an invoice records an audit trail', async () => {
  const db = await fresh();
  const clientId = createClient(db, { displayName: 'Ada', now: T0 });
  const invoiceId = createInvoice(db, { number: 'A', clientId, currency: 'NGN', amountMinor: 100000, issuedOn: T0, dueOn: T0, now: T0 });

  const trail = db.rows('SELECT action FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id', ['invoice', invoiceId]);
  assert.ok(trail.some((row) => row.action === 'invoice.create'));
});
