// Matching: proposing what a payment probably settles, and never deciding it.
//
// The temptation in an invoicing tool is to auto-allocate: money arrived, find the
// invoice with the same amount, mark it paid. That is the single most common
// source of quiet ledger errors, because two invoices for ₦450,000 make the choice
// arbitrary and the query decides by row order. The client who actually paid the
// other one gets chased.
//
// So this module only proposes. It scores candidates, says why, and marks a
// proposal `confident` only when one candidate is clearly ahead of the rest — and
// even then, the caller has to ask for the allocation. Confidence here means "you
// probably do not need to look hard", not "I went ahead".
//
// Signals, strongest first:
//   1. The invoice number appears in the narration. Almost never wrong.
//   2. The client's name appears in the narration.
//   3. The amount matches the outstanding balance exactly.
//   4. The amount matches the original invoice total (part-paid already).
//   5. The payment date is close to the due date.
//
// Signals 1 and 2 are evidence of *who*, and who is what actually disambiguates.
// Amount alone is the weakest of the strong signals, which is the opposite of how
// most tools weight it.

const DAY = 24 * 60 * 60 * 1000;

/** Words too common to be evidence of a client's identity. */
const STOPWORDS = new Set([
  'transfer', 'payment', 'from', 'to', 'the', 'and', 'for', 'ltd', 'limited',
  'nig', 'ngn', 'bank', 'credit', 'debit', 'inward', 'outward', 'mobile', 'web',
  'trf', 'nip', 'neft', 'pos', 'atm', 'ref', 'sent', 'received', 'via',
]);

function words(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * How much of the client's name appears in the narration.
 *
 * Returns 0..1 — the fraction of the name's distinctive words present. "Ada Obi"
 * against "TRANSFER FROM ADA OBI" is 1.0; against "TRANSFER FROM OBI" is 0.5.
 */
export function nameOverlap(descriptor, clientName) {
  const nameWords = words(clientName);
  if (nameWords.length === 0) return 0;
  const descriptorWords = new Set(words(descriptor));
  const hits = nameWords.filter((w) => descriptorWords.has(w)).length;
  return hits / nameWords.length;
}

/**
 * Propose settlements for one payment.
 *
 * @returns {Array<{invoiceId, number, clientId, clientName, outstandingMinor,
 *   score, confident, reasons}>} ranked, best first
 */
export function proposeMatches(db, payment, { now = Date.now(), limit = 5 } = {}) {
  const outstandingMinor = payment.unallocatedMinor
    ?? payment.amount_minor
    - db.value(
      'SELECT COALESCE(SUM(amount_minor), 0) FROM allocation WHERE payment_id = ?',
      [payment.id],
    );

  if (outstandingMinor <= 0) return [];

  // Candidates are open invoices in the same currency. Cross-currency matching is
  // never proposed, because an exchange rate is a guess and this module does not
  // guess.
  const open = db.rows(
    // issued_on is selected because the date guard below compares against it. It
    // was missing at first, so the guard compared a payment date to `undefined`
    // and every stale payment matched an invoice that did not exist yet.
    `SELECT i.id, i.number, i.client_id, i.currency, i.amount_minor, i.issued_on, i.due_on,
            p.display_name AS client_name,
            i.amount_minor - COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.invoice_id = i.id), 0) AS outstanding
       FROM invoice i
       JOIN party p ON p.id = i.client_id
      WHERE i.voided_at IS NULL
        AND i.status <> 'paid'
        AND i.currency = ?
      ORDER BY i.due_on`,
    [payment.currency],
  );

  const descriptor = String(payment.raw_descriptor || '');
  const descriptorUpper = descriptor.toUpperCase();

  const scored = open.map((invoice) => {
    const reasons = [];
    let score = 0;
    // Confidence needs two independent kinds of evidence: WHO paid, and HOW MUCH.
    // A name alone does not say which invoice; an amount alone does not say whose.
    // Tracking them separately is what stops a part payment being called
    // confident just because the narration happens to name the client.
    let knowsWho = false;
    let knowsHowMuch = false;

    // 1. The invoice number, verbatim. "INV-0001" in a narration is a client
    //    telling you exactly what they paid.
    const number = String(invoice.number || '');
    if (number && descriptorUpper.includes(number.toUpperCase())) {
      score += 100;
      knowsWho = true;
      knowsHowMuch = true;
      reasons.push(`narration names ${number}`);
    } else {
      // The bare digits, for clients who type "0001" and drop the prefix.
      const digits = number.replace(/[^0-9]/g, '');
      if (digits.length >= 3 && descriptor.replace(/[^0-9]/g, '').includes(digits)) {
        score += 40;
        reasons.push(`narration contains the digits of ${number}`);
      }
    }

    // 2. The client's name. This is the signal that actually disambiguates two
    //    invoices for the same amount.
    const overlap = nameOverlap(descriptor, invoice.client_name);
    if (overlap >= 1) {
      score += 60;
      knowsWho = true;
      reasons.push(`narration names ${invoice.client_name}`);
    } else if (overlap >= 0.5) {
      score += 30;
      knowsWho = true;
      reasons.push(`narration partly names ${invoice.client_name}`);
    }

    // 3. Exact outstanding match.
    if (invoice.outstanding === outstandingMinor) {
      score += 45;
      knowsHowMuch = true;
      reasons.push('amount matches the outstanding balance exactly');
    } else if (invoice.amount_minor === outstandingMinor) {
      score += 25;
      knowsHowMuch = true;
      reasons.push('amount matches the original invoice total');
    }

    // A payment that predates the invoice cannot be settling it. Scored out
    // entirely rather than merely penalised: this is not weak evidence, it is
    // evidence against.
    if (payment.received_on && payment.received_on < invoice.issued_on) {
      return { invoice, score: -1, reasons: ['payment predates the invoice'], knowsWho: false, knowsHowMuch: false };
    }

    // 4. Proximity to the due date — weak on its own, useful as a tiebreak.
    if (payment.received_on && invoice.due_on) {
      const drift = Math.abs(payment.received_on - invoice.due_on) / DAY;
      if (drift <= 7) {
        score += 10;
        reasons.push('paid within a week of the due date');
      } else if (drift <= 30) {
        score += 3;
      }
    }

    // 5. Same client, but nothing else pointing at this invoice. Worth a little,
    //    because a client with one open invoice paying the right amount is the
    //    ordinary case.
    if (invoice.client_id === payment.client_id && reasons.length === 0) {
      score += 8;
      reasons.push('same client');
    }

    return { invoice, score, reasons, knowsWho, knowsHowMuch };
  });

  const ranked = scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.invoice.due_on - b.invoice.due_on)
    .slice(0, limit);

  if (ranked.length === 0) {
    // Saying only "no match" hides the reason, and the reason is usually
    // actionable. The common case is a statement imported for a period before the
    // invoices existed — the operator then believes the matcher is broken rather
    // than that they pointed it at the wrong month.
    const rejectedForDate = scored.filter((row) => row.reasons.includes('payment predates the invoice'));
    if (rejectedForDate.length > 0 && rejectedForDate.length === scored.length) {
      return [{
        invoiceId: null,
        number: null,
        clientId: null,
        clientName: null,
        outstandingMinor: 0,
        dueOn: null,
        score: 0,
        confident: false,
        // A reason with no candidate attached: this is an explanation, not a
        // proposal, and callers must check invoiceId before acting on it.
        reasons: [
          'every open invoice for this client was issued after this payment arrived — ' +
          'check the statement period, or the invoice dates',
        ],
      }];
    }
    return [];
  }

  // Confident means one candidate is clearly ahead: at least 45 points (roughly
  // an exact-amount match) and a 20-point gap over the runner-up. Anything less
  // and the honest answer is "a human should look".
  const [best, second] = ranked;
  const gap = second ? best.score - second.score : Infinity;

  return ranked.map((row, index) => ({
    invoiceId: row.invoice.id,
    number: row.invoice.number,
    clientId: row.invoice.client_id,
    clientName: row.invoice.client_name,
    outstandingMinor: row.invoice.outstanding,
    dueOn: row.invoice.due_on,
    score: row.score,
    // Confident requires: first place, a real score, a clear gap, and BOTH kinds
    // of evidence. An amount with no name is a coincidence waiting to happen; a
    // name with no amount is a payment that may be for something else entirely.
    confident: index === 0 && best.score >= 45 && gap >= 20 && row.knowsWho && row.knowsHowMuch,
    reasons: row.reasons,
  }));
}

/**
 * The review queue: every payment with money still unallocated, with proposals.
 *
 * This is the screen a freelancer actually needs — money that arrived and has not
 * been credited to anything is the state where a chase and a payment cross.
 */
export function reviewQueue(db, { now = Date.now(), limit = 50 } = {}) {
  const payments = db.rows(
    `SELECT pay.id, pay.client_id, pay.currency, pay.amount_minor, pay.received_on,
            pay.source, pay.external_ref, pay.raw_descriptor,
            p.display_name AS client_name,
            pay.amount_minor - COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.payment_id = pay.id), 0) AS unallocatedMinor
       FROM payment pay
       JOIN party p ON p.id = pay.client_id
      WHERE pay.amount_minor > COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.payment_id = pay.id), 0)
      ORDER BY pay.received_on DESC, pay.id DESC
      LIMIT ?`,
    [limit],
  );

  return payments.map((payment) => ({
    ...payment,
    proposals: proposeMatches(db, payment, { now }),
  }));
}
