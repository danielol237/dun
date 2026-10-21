// Parties, invoices and payments — the domain layer.
//
// Every method here writes its ledger entries in the same transaction as the
// record itself. That is the invariant that makes the rest of the system
// trustworthy: there is no path that creates an invoice without booking a
// receivable, or records a payment without booking cash.

import { Ledger, ACCOUNTS } from './ledger.mjs';
import { isValidAmount, formatAmount, sum } from './money.mjs';

/** Date-only helper: midnight UTC, because due dates are dates, not instants. */
export function dayStart(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid date: ${value}`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function addDays(timestamp, days) {
  return timestamp + days * 24 * 60 * 60 * 1000;
}

/* ------------------------------------------------------------------ parties */

export function createClient(db, { displayName, handles = [], now = Date.now() }) {
  if (!displayName || typeof displayName !== 'string' || displayName.trim().length === 0) {
    throw new Error('client needs a display name');
  }

  return db.transaction(() => {
    db.run('INSERT INTO party (kind, display_name, created_at) VALUES (?, ?, ?)', [
      'client',
      displayName.trim(),
      now,
    ]);
    const id = db.lastId();

    for (const handle of handles) {
      addHandle(db, id, handle, now);
    }

    audit(db, now, 'user', 'party.create', 'party', id, { displayName });
    return id;
  });
}

/**
 * Normalise a channel handle.
 *
 * A phone number that is stored as "+234 803 123 4567" in one place and
 * "08031234567" in another is two parties that never reconcile. Everything is
 * reduced to one form at the boundary, and this is that boundary.
 */
export function normaliseHandle(channel, value) {
  const raw = String(value ?? '').trim();
  if (raw.length === 0) throw new Error('empty handle');

  switch (channel) {
    case 'email':
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(raw)) throw new Error(`invalid email: ${value}`);
      return raw.toLowerCase();

    case 'whatsapp':
    case 'sms':
    case 'phone': {
      const digits = raw.replace(/[^\d+]/g, '');
      if (digits.length < 7) throw new Error(`invalid phone: ${value}`);

      // Nigerian numbers are written locally as 0803… and internationally as
      // +234803…. Storing the local form as-is guarantees a duplicate party.
      if (/^0\d{10}$/.test(digits)) return `+234${digits.slice(1)}`;
      if (/^234\d{10}$/.test(digits)) return `+${digits}`;
      if (/^\+\d{7,15}$/.test(digits)) return digits;
      if (/^\d{7,15}$/.test(digits)) return `+${digits}`;

      throw new Error(`invalid phone: ${value}`);
    }

    default:
      throw new Error(`unknown channel: ${channel}`);
  }
}

export function addHandle(db, partyId, { channel, value, verified = false }, now = Date.now()) {
  const normalised = normaliseHandle(channel, value);

  db.run(
    `INSERT INTO party_handle (party_id, channel, value, verified_at, created_at)
     VALUES (?,?,?,?,?)`,
    [partyId, channel, normalised, verified ? now : null, now],
  );

  return db.lastId();
}

export function findPartyByHandle(db, channel, value) {
  const normalised = normaliseHandle(channel, value);
  return db.row(
    `SELECT p.* FROM party p
       JOIN party_handle h ON h.party_id = p.id
      WHERE h.channel = ? AND h.value = ?`,
    [channel, normalised],
  );
}

/* ----------------------------------------------------------------- invoices */

/**
 * Create an invoice and book the receivable.
 *
 * The invoice row and the ledger entries are written together. If the ledger
 * write throws, the invoice does not exist — which is why this is not a
 * best-effort sequence of statements.
 */
export function createInvoice(
  db,
  { number, clientId, currency, amountMinor, issuedOn, dueOn, lines = [], origin = 'manual', externalRef = null, note = null, now = Date.now() },
) {
  if (!number || typeof number !== 'string') throw new Error('invoice needs a number');
  if (!isValidAmount(amountMinor, currency) || amountMinor === 0) {
    throw new Error('invoice needs a positive amount in minor units');
  }

  const issued = dayStart(issuedOn);
  const due = dayStart(dueOn);

  if (due < issued) throw new Error('due date cannot precede the issue date');

  const client = db.row('SELECT id, kind FROM party WHERE id = ?', [clientId]);
  if (!client) throw new Error(`unknown client: ${clientId}`);
  if (client.kind !== 'client') throw new Error('an invoice must be addressed to a client');

  return db.transaction(() => {
    db.run(
      `INSERT INTO invoice
         (number, client_id, currency, amount_minor, issued_on, due_on, status, origin, external_ref, note, created_at)
       VALUES (?,?,?,?,?,?, 'open', ?,?,?,?)`,
      [number, clientId, currency, amountMinor, issued, due, origin, externalRef, note, now],
    );
    const id = db.lastId();

    lines.forEach((line, index) => {
      db.run(
        `INSERT INTO invoice_line (invoice_id, description, quantity, unit_minor, position)
         VALUES (?,?,?,?,?)`,
        [id, line.description, line.quantity ?? 1, line.unitMinor, index],
      );
    });

    const ledger = new Ledger(db);
    ledger.post({
      causeKind: 'invoice',
      causeId: id,
      amountMinor,
      currency,
      postedAt: issued,
      debitAccount: ACCOUNTS.RECEIVABLE,
      creditAccount: ACCOUNTS.REVENUE,
      partyId: clientId,
      memo: `Invoice ${number}`,
    });

    audit(db, now, 'user', 'invoice.create', 'invoice', id, { number, amountMinor, currency });
    return id;
  });
}

/** Read an invoice with its client, allocations and derived balance. */
export function getInvoice(db, invoiceId) {
  const invoice = db.row(
    `SELECT i.*, p.display_name AS client_name
       FROM invoice i JOIN party p ON p.id = i.client_id
      WHERE i.id = ?`,
    [invoiceId],
  );
  if (!invoice) return null;

  const allocated = db.value(
    'SELECT COALESCE(SUM(amount_minor), 0) AS n FROM allocation WHERE invoice_id = ?',
    [invoiceId],
  );

  const lines = db.rows(
    'SELECT * FROM invoice_line WHERE invoice_id = ? ORDER BY position',
    [invoiceId],
  );

  const outstanding = Math.max(0, invoice.amount_minor - allocated);

  return {
    ...invoice,
    lines,
    allocatedMinor: allocated,
    outstandingMinor: outstanding,
    amountFormatted: formatAmount(invoice.amount_minor, invoice.currency),
    outstandingFormatted: formatAmount(outstanding, invoice.currency),
  };
}

/** Every open invoice, oldest due first — the chase queue. */
export function openInvoices(db, { now = Date.now() } = {}) {
  return db.rows(
    `SELECT i.*, p.display_name AS client_name,
            i.amount_minor - COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.invoice_id = i.id), 0) AS outstanding_minor
       FROM invoice i
       JOIN party p ON p.id = i.client_id
      WHERE i.status IN ('open', 'part_paid')
        AND i.voided_at IS NULL
      ORDER BY i.due_on ASC`,
  );
}

/**
 * Void an invoice.
 *
 * Not a delete. The receivable is reversed, the invoice is marked void, and
 * both facts remain in the history. A client who was told they owed money and
 * then told they did not should be able to see both events.
 */
export function voidInvoice(db, invoiceId, { reason = null, now = Date.now() } = {}) {
  return db.transaction(() => {
    const invoice = getInvoice(db, invoiceId);
    if (!invoice) throw new Error(`unknown invoice: ${invoiceId}`);
    if (invoice.status === 'void') return { alreadyVoid: true };

    const allocated = invoice.allocatedMinor;
    if (allocated > 0) {
      throw new Error('cannot void an invoice that has payments allocated to it');
    }

    const ledger = new Ledger(db);
    ledger.post({
      causeKind: 'reversal',
      causeId: invoiceId,
      amountMinor: invoice.amount_minor,
      currency: invoice.currency,
      postedAt: now,
      debitAccount: ACCOUNTS.REVENUE,
      creditAccount: ACCOUNTS.RECEIVABLE,
      partyId: invoice.client_id,
      memo: `Void ${invoice.number}${reason ? `: ${reason}` : ''}`,
    });

    db.run("UPDATE invoice SET status = 'void', voided_at = ? WHERE id = ?", [now, invoiceId]);
    audit(db, now, 'user', 'invoice.void', 'invoice', invoiceId, { reason });

    return { voided: true };
  });
}

/* ----------------------------------------------------------------- payments */

/**
 * Record a payment and allocate it.
 *
 * Allocation is explicit, not inferred. Auto-matching a payment to an invoice
 * by amount is the classic source of quiet ledger errors: two invoices for the
 * same amount, and the money lands on whichever one the query returned first.
 * The caller says which invoice it settles; anything unallocated sits as a
 * credit against the client, which is visible and correctable.
 */
export function recordPayment(
  db,
  { clientId, currency, amountMinor, receivedOn, source = 'manual', externalRef = null, rawDescriptor = null, allocations = [], now = Date.now() },
) {
  if (!isValidAmount(amountMinor, currency) || amountMinor === 0) {
    throw new Error('payment needs a positive amount in minor units');
  }

  const received = dayStart(receivedOn);

  const allocatedTotal = sum(allocations.map((a) => a.amountMinor), currency);
  if (allocatedTotal > amountMinor) {
    throw new Error('allocations exceed the payment amount');
  }

  return db.transaction(() => {
    db.run(
      `INSERT INTO payment
         (client_id, currency, amount_minor, received_on, source, external_ref, raw_descriptor, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [clientId, currency, amountMinor, received, source, externalRef, rawDescriptor, now],
    );
    const paymentId = db.lastId();

    const ledger = new Ledger(db);
    ledger.post({
      causeKind: 'payment',
      causeId: paymentId,
      amountMinor,
      currency,
      postedAt: received,
      debitAccount: ACCOUNTS.CASH,
      creditAccount: ACCOUNTS.RECEIVABLE,
      partyId: clientId,
      memo: `Payment${rawDescriptor ? ` — ${rawDescriptor}` : ''}`,
    });

    for (const allocation of allocations) {
      allocate(db, paymentId, allocation.invoiceId, allocation.amountMinor, now);
    }

    audit(db, now, source === 'manual' ? 'user' : source, 'payment.record', 'payment', paymentId, {
      amountMinor,
      currency,
    });

    return paymentId;
  });
}

/** Allocate part of a payment to an invoice, and update the invoice status. */
export function allocate(db, paymentId, invoiceId, amountMinor, now = Date.now()) {
  return db.transaction(() => {
    const payment = db.row('SELECT * FROM payment WHERE id = ?', [paymentId]);
    if (!payment) throw new Error(`unknown payment: ${paymentId}`);

    const invoice = getInvoice(db, invoiceId);
    if (!invoice) throw new Error(`unknown invoice: ${invoiceId}`);
    if (invoice.voided_at) throw new Error('cannot allocate to a voided invoice');
    if (invoice.currency !== payment.currency) {
      throw new Error('cannot allocate across currencies');
    }
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error('allocation must be a positive integer');
    }
    if (amountMinor > invoice.outstandingMinor) {
      throw new Error(
        `allocation exceeds outstanding: ${formatAmount(amountMinor, invoice.currency)} > ${formatAmount(invoice.outstandingMinor, invoice.currency)}`,
      );
    }

    // A payment cannot give away more than it has left.
    const alreadyAllocated = db.value(
      'SELECT COALESCE(SUM(amount_minor), 0) AS n FROM allocation WHERE payment_id = ?',
      [paymentId],
    );
    if (alreadyAllocated + amountMinor > payment.amount_minor) {
      throw new Error('payment has insufficient unallocated balance');
    }

    db.run(
      'INSERT INTO allocation (payment_id, invoice_id, amount_minor, created_at) VALUES (?,?,?,?)',
      [paymentId, invoiceId, amountMinor, now],
    );

    const updated = getInvoice(db, invoiceId);
    const status = updated.outstandingMinor === 0 ? 'paid' : 'part_paid';
    db.run('UPDATE invoice SET status = ? WHERE id = ?', [status, invoiceId]);

    audit(db, now, 'system', 'payment.allocate', 'invoice', invoiceId, { paymentId, amountMinor });
    return { status, outstandingMinor: updated.outstandingMinor };
  });
}

/* -------------------------------------------------------------------- audit */

export function audit(db, at, actor, action, entity, entityId, detail = null) {
  db.run(
    `INSERT INTO audit_log (at, actor, action, entity, entity_id, detail_json)
     VALUES (?,?,?,?,?,?)`,
    [at, actor, action, entity, entityId, detail ? JSON.stringify(detail) : null],
  );
}
