// Importing a statement: recording what happened, deciding nothing.
//
// The parser (statement.mjs) and the matcher (matcher.mjs) are pure. This is the
// part that writes, and it is deliberately the smallest of the three.
//
// Three properties, ordered by how much damage each prevents:
//
//   1. The same file imported twice changes nothing. Bank feeds re-deliver rows
//      routinely; a payment counted twice is a client chased after paying. The
//      unique key is (source, external_ref) and the database enforces it, so this
//      holds even if two imports race.
//
//   2. Only inflows become payments. A debit is reported in the import result,
//      not recorded. An import that turns a withdrawal into a payment credits a
//      client who never paid, and the error is invisible until someone reconciles
//      by hand.
//
//   3. Nothing is allocated. Every imported payment lands unallocated, with
//      proposals attached, and stays that way until a person confirms. That is
//      the entire reason matcher.mjs refuses to be confident on an amount alone.

import { recordPayment, findPartyByHandle } from './domain.mjs';
import { onPaymentRecorded } from './scheduler.mjs';
import { parseStatement, creditsOnly } from './statement.mjs';
import { proposeMatches } from './matcher.mjs';

/**
 * Work out which client a credit belongs to.
 *
 * Tries, in order:
 *   1. A phone number in the narration that matches a handle on file. A client
 *      paying from the number they message you on is the strongest link there is.
 *   2. The longest client name appearing in the narration. Longest first, so
 *      "Ada Obi" is not shadowed by a client called "Ada".
 *
 * Returns null when it cannot tell. An unattributed payment is a question for a
 * human; inventing an owner is how money lands on the wrong account.
 */
export function attributeClient(db, transaction) {
  const text = String(transaction.descriptor || '').trim();
  if (!text) return null;

  const digits = text.replace(/[^\d]/g, '');
  if (digits.length >= 10) {
    for (const candidate of [digits, `+${digits}`, digits.slice(-10)]) {
      const party = findPartyByHandle(db, 'whatsapp', candidate);
      if (party) return party.id;
    }
  }

  const clients = db.rows(
    "SELECT id, display_name FROM party WHERE kind = 'client' ORDER BY LENGTH(display_name) DESC",
  );
  const haystack = text.toLowerCase();
  for (const client of clients) {
    const name = String(client.display_name || '').toLowerCase().trim();
    if (name.length >= 3 && haystack.includes(name)) return client.id;
  }

  return null;
}

/**
 * Import a statement.
 *
 * @param {string} text       CSV contents
 * @param {object} options    { currency, source, now, columnOverrides }
 * @returns {{
 *   imported: number, duplicates: number, unattributed: number,
 *   debitsIgnored: number, rejected: Array, columns: object,
 *   payments: Array<{paymentId, proposals}>
 * }}
 */
export function importStatement(
  db,
  text,
  { currency = 'NGN', source = 'feed:manual', now = Date.now(), columnOverrides = {} } = {},
) {
  const parsed = parseStatement(text, { currency, overrides: columnOverrides });
  const credits = creditsOnly(parsed.transactions);
  const debits = parsed.transactions.filter((t) => t.direction === 'out');

  const payments = [];
  let duplicates = 0;
  let unattributed = 0;

  db.transaction(() => {
    for (const credit of credits) {
      const existing = db.row(
        'SELECT id FROM payment WHERE source = ? AND external_ref = ?',
        [source, credit.externalRef],
      );
      if (existing) { duplicates += 1; continue; }

      const clientId = attributeClient(db, credit);
      if (!clientId) {
        // Reported, not recorded against a placeholder. Re-importing after the
        // client is added is safe, because this import is idempotent.
        unattributed += 1;
        continue;
      }

      const paymentId = recordPayment(db, {
        clientId,
        currency,
        amountMinor: credit.amountMinor,
        receivedOn: credit.receivedOn,
        source,
        externalRef: credit.externalRef,
        rawDescriptor: credit.descriptor || null,
        // No allocations. Ever. This is the line that keeps the ledger honest.
        allocations: [],
        now,
      });

      // Money landing stops the chase immediately. That join is what makes the
      // product feel alive rather than automated.
      onPaymentRecorded(db, { clientId, currency, now });

      const payment = db.row('SELECT * FROM payment WHERE id = ?', [paymentId]);
      payments.push({ paymentId, proposals: proposeMatches(db, payment, { now }) });
    }
  });

  return {
    imported: payments.length,
    duplicates,
    unattributed,
    debitsIgnored: debits.length,
    rejected: parsed.rejected,
    columns: parsed.columns,
    payments,
  };
}
