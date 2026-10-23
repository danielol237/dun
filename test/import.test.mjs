// Importing: the properties that keep a bank feed from corrupting the ledger.
//
// Each test here maps to a way a real import goes wrong and a client ends up
// chased after paying:
//
//   - the file is delivered twice by the bank, and the payment counts twice
//   - a withdrawal is read as a payment, crediting a client who never paid
//   - a payment with an unrecognisable payer is silently attached to someone
//   - the money is auto-allocated to the wrong invoice of two identical ones
//
// The last is the one this repo cares about most, and it is why the import
// deliberately leaves every payment unallocated.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../src/db.mjs';
import { createClient, createInvoice } from '../src/domain.mjs';
import { importStatement, attributeClient } from '../src/import.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 1);

async function fresh() {
  return Db.open(':memory:');
}

function client(db, name, whatsapp, now = T0) {
  return createClient(db, { displayName: name, handles: [{ channel: 'whatsapp', value: whatsapp }], now });
}

function invoice(db, { number, clientId, amountMinor = 45000000 }) {
  return createInvoice(db, {
    number, clientId, currency: 'NGN', amountMinor,
    issuedOn: T0 - 30 * DAY, dueOn: T0 - 20 * DAY, now: T0 - 30 * DAY,
  });
}

const GT_STATEMENT = [
  'Transaction Date,Narration,Credit,Debit,Reference',
  '01/06/2026,TRANSFER FROM ADA OBI INV-0001,450000.00,,GT123',
  '02/06/2026,ATM WITHDRAWAL LAGOS,,20000.00,GT124',
  '03/06/2026,TRANSFER FROM ADA OBI,1000.00,,GT125',
].join('\n');

/* ── Attribution ──────────────────────────────────────────────────────────── */

test('a phone number in the narration finds the client', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');

    const found = attributeClient(db, { descriptor: 'TRANSFER FROM 2348012345678' });
    assert.equal(found, ada);

    await db.close();
  })();
});

test('a name in the narration finds the client', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');

    assert.equal(attributeClient(db, { descriptor: 'TRANSFER FROM ADA OBI' }), ada);

    await db.close();
  })();
});

test('the longest matching name wins', () => {
  return (async () => {
    const db = await fresh();
    // A client literally called "Ada" must not shadow "Ada Obi".
    client(db, 'Ada', '+2348011111111');
    const adaObi = client(db, 'Ada Obi', '+2348012345678');

    assert.equal(attributeClient(db, { descriptor: 'TRANSFER FROM ADA OBI' }), adaObi);

    await db.close();
  })();
});

test('an unrecognisable payer is attributed to nobody', () => {
  return (async () => {
    const db = await fresh();
    client(db, 'Ada Obi', '+2348012345678');

    // Inventing an owner here is how money lands on the wrong account.
    assert.equal(attributeClient(db, { descriptor: 'TRANSFER FROM J SMITH' }), null);
    assert.equal(attributeClient(db, { descriptor: '' }), null);

    await db.close();
  })();
});

/* ── Import ───────────────────────────────────────────────────────────────── */

test('a statement imports its credits and ignores its debits', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada });

    const result = importStatement(db, GT_STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: T0 });

    assert.equal(result.imported, 2, 'both credits for Ada');
    assert.equal(result.debitsIgnored, 1, 'the withdrawal is reported, not recorded');
    assert.equal(db.value('SELECT COUNT(*) FROM payment'), 2);
    assert.equal(db.value("SELECT COUNT(*) FROM payment WHERE amount_minor = 2000000"), 0, 'no debit became a payment');

    await db.close();
  })();
});

test('importing the same statement twice is a no-op', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada });

    const first = importStatement(db, GT_STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: T0 });
    assert.equal(first.imported, 2);

    const second = importStatement(db, GT_STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: T0 });
    assert.equal(second.imported, 0, 'nothing new');
    assert.equal(second.duplicates, 2, 'both recognised as already imported');

    // The ledger must not have grown. This is the whole point: a client who paid
    // once must not have two payments on file.
    assert.equal(db.value('SELECT COUNT(*) FROM payment'), 2);

    await db.close();
  })();
});

test('the same reference from a different source is a different payment', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada });

    importStatement(db, GT_STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: T0 });
    const other = importStatement(db, GT_STATEMENT, { currency: 'NGN', source: 'feed:access', now: T0 });

    // Two banks can use the same reference scheme. The source is part of the
    // identity, or one bank's rows would silently suppress another's.
    assert.equal(other.imported, 2);

    await db.close();
  })();
});

test('an unattributable credit is reported and not recorded', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada });

    const csv = [
      'Date,Narration,Credit,Reference',
      '01/06/2026,TRANSFER FROM UNKNOWN PARTY,5000.00,X1',
    ].join('\n');

    const result = importStatement(db, csv, { currency: 'NGN', source: 'feed:test', now: T0 });

    assert.equal(result.imported, 0);
    assert.equal(result.unattributed, 1);
    assert.equal(db.value('SELECT COUNT(*) FROM payment'), 0, 'nothing invented');

    await db.close();
  })();
});

test('imported payments are never auto-allocated', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    const chinedu = client(db, 'Chinedu Eze', '+2348099999999');

    // Two identical invoices — the scenario auto-allocation gets wrong.
    invoice(db, { number: 'INV-0001', clientId: ada });
    invoice(db, { number: 'INV-0002', clientId: chinedu });

    const csv = [
      'Date,Narration,Credit,Reference',
      '01/06/2026,TRANSFER FROM ADA OBI,450000.00,GT1',
    ].join('\n');

    const result = importStatement(db, csv, { currency: 'NGN', source: 'feed:test', now: T0 });

    assert.equal(result.imported, 1);
    assert.equal(db.value('SELECT COUNT(*) FROM allocation'), 0, 'nothing may be allocated automatically');

    // The proposal is there, and it is the right one, but a human still confirms.
    const proposal = result.payments[0].proposals[0];
    assert.equal(proposal.number, 'INV-0001');
    assert.equal(proposal.confident, true, 'naming the client is enough to be confident');

    await db.close();
  })();
});

test('a payment landing cancels the chase', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    const inv = invoice(db, { number: 'INV-0001', clientId: ada });

    // Queue a reminder first, so there is a chase to cancel.
    db.run(
      `INSERT INTO reminder (invoice_id, policy_step_id, channel, template_key, scheduled_for, state, created_at)
       VALUES (?, NULL, 'whatsapp', 'late_gentle', ?, 'pending', ?)`,
      [inv, T0, T0],
    );
    assert.equal(db.value("SELECT COUNT(*) FROM reminder WHERE state = 'pending'"), 1);

    const csv = [
      'Date,Narration,Credit,Reference',
      '01/06/2026,TRANSFER FROM ADA OBI,450000.00,GT1',
    ].join('\n');

    importStatement(db, csv, { currency: 'NGN', source: 'feed:test', now: T0 });

    // A client who pays must stop being chased immediately. This join is the
    // difference between a product and a script.
    assert.equal(
      db.value("SELECT COUNT(*) FROM reminder WHERE state = 'pending'"),
      0,
      'an arriving payment must cancel pending reminders',
    );

    await db.close();
  })();
});

test('an unreadable row is reported through the import result', () => {
  return (async () => {
    const db = await fresh();
    client(db, 'Ada Obi', '+2348012345678');

    const csv = [
      'Date,Narration,Credit,Reference',
      '01/06/2026,TRANSFER FROM ADA OBI,450000.00,GT1',
      'garbage,TRANSFER FROM ADA OBI,100.00,GT2',
    ].join('\n');

    const result = importStatement(db, csv, { currency: 'NGN', source: 'feed:test', now: T0 });

    assert.equal(result.imported, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].line, 3);

    await db.close();
  })();
});

test('the ledger stays balanced after an import', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada });

    importStatement(db, GT_STATEMENT, { currency: 'NGN', source: 'feed:gtbank', now: T0 });

    // Every entry group must net to zero. If an import ever posts one side of a
    // payment without the other, this is where it surfaces.
    const unbalanced = db.rows(
      `SELECT entry_group, SUM(debit_minor) AS dr, SUM(credit_minor) AS cr
         FROM ledger_entry GROUP BY entry_group HAVING dr <> cr`,
    );
    assert.equal(unbalanced.length, 0, `unbalanced groups: ${JSON.stringify(unbalanced)}`);

    await db.close();
  })();
});
