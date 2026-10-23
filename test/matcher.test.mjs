// Matching: proposing, and the discipline of not deciding.
//
// The failure these cover is the reason matcher.mjs exists at all. An invoicing
// tool that auto-allocates by amount will, on the day a client has two invoices
// for the same figure, credit the wrong one — and then chase the client who
// actually paid. The tests below are mostly about what the matcher refuses to do.
//
// The disambiguation signal that works is *who*, not *how much*. A narration
// naming the client or the invoice number settles it; an amount on its own does
// not, and must never be treated as though it does.

import test from 'node:test';
import assert from 'node:assert/strict';

import { Db } from '../src/db.mjs';
import { createClient, createInvoice, recordPayment } from '../src/domain.mjs';
import { nameOverlap, proposeMatches, reviewQueue } from '../src/matcher.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 5, 1);

async function fresh() {
  return Db.open(':memory:');
}

function client(db, name, whatsapp, now = T0) {
  return createClient(db, { displayName: name, handles: [{ channel: 'whatsapp', value: whatsapp }], now });
}

function invoice(db, { number, clientId, amountMinor = 45000000, issuedOn = T0 - 30 * DAY, dueOn = T0 - 20 * DAY }) {
  return createInvoice(db, {
    number, clientId, currency: 'NGN', amountMinor, issuedOn, dueOn, now: issuedOn,
  });
}

function payment(db, { clientId, amountMinor, receivedOn = T0, descriptor = '', ref = null }) {
  return recordPayment(db, {
    clientId,
    currency: 'NGN',
    amountMinor,
    receivedOn,
    source: 'feed:test',
    externalRef: ref,
    rawDescriptor: descriptor,
    now: T0,
  });
}

function loaded(db, id) {
  return db.row('SELECT * FROM payment WHERE id = ?', [id]);
}

/* ── Name overlap ─────────────────────────────────────────────────────────── */

test('a full name in the narration is full overlap', () => {
  assert.equal(nameOverlap('TRANSFER FROM ADA OBI', 'Ada Obi'), 1);
});

test('a partial name is partial overlap', () => {
  // Half the name is weak evidence on its own, which is exactly why it scores
  // less than a full match.
  assert.equal(nameOverlap('TRANSFER FROM OBI', 'Ada Obi'), 0.5);
});

test('bank noise does not count as a name match', () => {
  // "TRANSFER FROM" appears in nearly every narration. If those words counted,
  // every payment would match every client called Transfer.
  assert.equal(nameOverlap('TRANSFER FROM PAYMENT', 'Transfer From'), 0);
});

test('an unrelated narration scores zero', () => {
  assert.equal(nameOverlap('ATM WITHDRAWAL LAGOS', 'Ada Obi'), 0);
});

/* ── Proposal quality ─────────────────────────────────────────────────────── */

test('a narration naming the invoice number is a confident match', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada });
    const pay = payment(db, { clientId: ada, amountMinor: 45000000, descriptor: 'TRANSFER INV-0001' });

    const proposals = proposeMatches(db, loaded(db, pay));
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].number, 'INV-0001');
    assert.equal(proposals[0].confident, true);
    assert.ok(proposals[0].reasons.some((r) => /names INV-0001/.test(r)));

    await db.close();
  })();
});

test('two identical invoices are NOT confidently matched — the whole point', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    const chinedu = client(db, 'Chinedu Eze', '+2348099999999');

    // The exact scenario that breaks auto-allocation: same amount, two clients.
    invoice(db, { number: 'INV-0001', clientId: ada });
    invoice(db, { number: 'INV-0002', clientId: chinedu });

    // A payment with no narration to disambiguate it.
    const pay = payment(db, { clientId: ada, amountMinor: 45000000, descriptor: '' });

    const proposals = proposeMatches(db, loaded(db, pay));

    // Both are proposed — the matcher does not pretend it knows.
    assert.ok(proposals.length >= 2, 'both candidates must be offered');

    // And nothing claims to be confident, because an amount alone is not
    // evidence of which one it settles.
    const confident = proposals.filter((p) => p.confident);
    assert.equal(confident.length, 0, 'an amount alone must never be a confident match');

    await db.close();
  })();
});

test('the client name disambiguates two identical invoices', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    const chinedu = client(db, 'Chinedu Eze', '+2348099999999');
    invoice(db, { number: 'INV-0001', clientId: ada });
    invoice(db, { number: 'INV-0002', clientId: chinedu });

    const pay = payment(db, { clientId: ada, amountMinor: 45000000, descriptor: 'TRANSFER FROM ADA OBI' });
    const proposals = proposeMatches(db, loaded(db, pay));

    assert.equal(proposals[0].number, 'INV-0001', 'the named client must win');
    assert.equal(proposals[0].confident, true, 'a name plus an exact amount is enough to be confident');

    await db.close();
  })();
});

test('a payment that predates the invoice is not proposed', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    // Invoice issued after the payment arrived. It cannot be settling it.
    invoice(db, { number: 'INV-0001', clientId: ada, issuedOn: T0 + 10 * DAY, dueOn: T0 + 40 * DAY });

    const pay = payment(db, { clientId: ada, amountMinor: 45000000, receivedOn: T0, descriptor: 'ADA OBI' });
    const proposals = proposeMatches(db, loaded(db, pay));

    // Either no proposal, or one that is not confident. Both are honest.
    const confident = proposals.filter((p) => p.confident);
    assert.equal(confident.length, 0);

    await db.close();
  })();
});

test('a paid invoice is not proposed', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    const inv = invoice(db, { number: 'INV-0001', clientId: ada });

    // Settle it in full.
    const first = payment(db, { clientId: ada, amountMinor: 45000000, descriptor: 'ADA OBI' });
    recordPayment(db, {
      clientId: ada, currency: 'NGN', amountMinor: 45000000, receivedOn: T0,
      source: 'feed:test', allocations: [{ invoiceId: inv, amountMinor: 45000000 }], now: T0,
    });

    const second = payment(db, { clientId: ada, amountMinor: 45000000, descriptor: 'ADA OBI again' });
    const proposals = proposeMatches(db, loaded(db, second));

    assert.ok(!proposals.some((p) => p.invoiceId === inv), 'a settled invoice must not be proposed');

    await db.close();
  })();
});

test('a different currency is never proposed', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    createInvoice(db, {
      number: 'USD-1', clientId: ada, currency: 'USD', amountMinor: 100000,
      issuedOn: T0 - 10 * DAY, dueOn: T0, now: T0 - 10 * DAY,
    });

    const pay = payment(db, { clientId: ada, amountMinor: 100000, descriptor: 'ADA OBI' });
    const proposals = proposeMatches(db, loaded(db, pay));

    // An exchange rate is a guess, and this module does not guess.
    assert.equal(proposals.length, 0);

    await db.close();
  })();
});

test('a part payment scores lower than an exact match', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada, amountMinor: 45000000 });

    const exact = payment(db, { clientId: ada, amountMinor: 45000000, descriptor: 'ADA OBI' });
    const exactProposals = proposeMatches(db, loaded(db, exact));

    const part = payment(db, { clientId: ada, amountMinor: 20000000, descriptor: 'ADA OBI' });
    const partProposals = proposeMatches(db, loaded(db, part));

    assert.ok(exactProposals[0].score > partProposals[0].score);
    // And a part payment is not confident: which invoice a part payment is
    // against is a judgement, not a calculation.
    assert.equal(partProposals[0].confident, false);

    await db.close();
  })();
});

/* ── Review queue ─────────────────────────────────────────────────────────── */

test('the review queue surfaces money that arrived and was never credited', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    invoice(db, { number: 'INV-0001', clientId: ada });

    payment(db, { clientId: ada, amountMinor: 45000000, descriptor: 'ADA OBI' });

    const queue = reviewQueue(db);
    assert.equal(queue.length, 1, 'an unallocated payment must appear');
    assert.equal(queue[0].unallocatedMinor, 45000000);
    assert.ok(queue[0].proposals.length > 0, 'and it must come with proposals');

    await db.close();
  })();
});

test('a fully allocated payment leaves the review queue', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    const inv = invoice(db, { number: 'INV-0001', clientId: ada });

    recordPayment(db, {
      clientId: ada, currency: 'NGN', amountMinor: 45000000, receivedOn: T0,
      source: 'feed:test', allocations: [{ invoiceId: inv, amountMinor: 45000000 }], now: T0,
    });

    assert.equal(reviewQueue(db).length, 0);

    await db.close();
  })();
});

test('a partly allocated payment stays in the queue with the remainder', () => {
  return (async () => {
    const db = await fresh();
    const ada = client(db, 'Ada Obi', '+2348012345678');
    const inv = invoice(db, { number: 'INV-0001', clientId: ada });

    recordPayment(db, {
      clientId: ada, currency: 'NGN', amountMinor: 45000000, receivedOn: T0,
      source: 'feed:test', allocations: [{ invoiceId: inv, amountMinor: 20000000 }], now: T0,
    });

    const queue = reviewQueue(db);
    assert.equal(queue.length, 1);
    assert.equal(queue[0].unallocatedMinor, 25000000, 'only the remainder is unallocated');

    await db.close();
  })();
});
