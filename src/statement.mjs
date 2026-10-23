// ── Bank statements: reading money that actually arrived ─────────────────────
//
// This is the other half of the product. Chasing works on what the ledger thinks
// is owed; the ledger only becomes true when payments land in it. Until now that
// meant typing each one in, which is the single task a freelancer will skip — and
// skipping it is why a chaser eventually demands money it has already been paid.
//
// A statement is a CSV because that is what every Nigerian bank exports. GTBank,
// Access, Zenith, Kuda and the rest all produce a file with the same *facts* and
// a different *header*: "Transaction Date" vs "Date" vs "Value Date", "Credit" vs
// "Credit Amount" vs a single signed "Amount". So the columns are detected by
// meaning, not by position, and any guess can be overridden explicitly.
//
// Two rules run through this file, and they are the reason it is safe to point at
// a real bank export:
//
//   1. Nothing is invented. A row whose date or amount cannot be read is
//      reported with a reason, never coerced into a number. A statement that
//      imports 39 of 40 rows and says which one it could not read is usable; one
//      that quietly drops it is a reconciliation bug waiting to be discovered
//      months later.
//
//   2. Nothing is allocated. Importing records that money arrived and who it
//      probably came from. It never decides which invoice it settles — that is
//      the exact inference the ledger design forbids, because two invoices for
//      the same amount make the choice arbitrary.
//
// Re-importing the same file must be a no-op. The bank's own transaction
// reference is the identity, and the schema enforces it.

import { parseAmount } from './money.mjs';

/* --------------------------------------------------------------------- CSV */

/**
 * Parse CSV text into rows of strings.
 *
 * Handles quoted fields, escaped quotes, embedded commas and embedded newlines —
 * all of which appear in real bank exports, usually in the narration column. A
 * naive split on commas corrupts exactly the field that says who paid.
 */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  // Strip a UTF-8 BOM. Excel adds one and it silently corrupts the first header.
  const src = String(text).replace(/^\uFEFF/, '');

  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  while (i < src.length) {
    const ch = src[i];

    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }

    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { pushField(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { pushRow(); i += 1; continue; }

    field += ch;
    i += 1;
  }

  // A file with no trailing newline still has a last row.
  if (field.length > 0 || row.length > 0) pushRow();

  return rows.filter((r) => r.some((cell) => String(cell).trim() !== ''));
}

/* ---------------------------------------------------------------- columns */

/**
 * Header synonyms, by meaning.
 *
 * Ordered: the first match wins, so a more specific header is listed before a
 * more general one ("value date" before "date").
 */
const HEADER_HINTS = {
  date: ['transaction date', 'value date', 'posting date', 'date', 'trans date', 'entry date'],
  amount: ['credit amount', 'credit', 'amount credited', 'money in', 'inflow', 'amount'],
  debit: ['debit amount', 'debit', 'amount debited', 'money out', 'outflow'],
  signedAmount: ['amount(net)', 'net amount', 'amount (ngn)', 'amount'],
  descriptor: ['narration', 'description', 'details', 'particulars', 'remarks', 'transaction details', 'narrative'],
  reference: ['transaction reference', 'reference', 'ref', 'transaction id', 'session id', 'cheque no', 'trace no'],
  balance: ['balance', 'running balance', 'closing balance'],
  type: ['type', 'transaction type', 'dr/cr', 'drcr'],
};

function normaliseHeader(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Work out which column means what.
 *
 * Returns an index per meaning, or -1. Never throws on an unfamiliar header — an
 * unknown column is simply unused, and the caller can override any of it.
 */
export function detectColumns(headers) {
  const normalised = headers.map(normaliseHeader);
  const taken = new Set();
  const found = {};

  // Specific meanings first. Claiming "amount" before "credit amount" would make
  // a statement with both columns read the wrong one, which is a silent sign
  // flip on every payment.
  const order = ['date', 'debit', 'amount', 'signedAmount', 'descriptor', 'reference', 'balance', 'type'];

  for (const meaning of order) {
    const hints = HEADER_HINTS[meaning] || [];
    let index = -1;

    for (const hint of hints) {
      const at = normalised.findIndex((h, i) => !taken.has(i) && h === hint);
      if (at !== -1) { index = at; break; }
    }

    // A looser pass, only if nothing matched exactly.
    if (index === -1) {
      for (const hint of hints) {
        const at = normalised.findIndex((h, i) => !taken.has(i) && h.includes(hint));
        if (at !== -1) { index = at; break; }
      }
    }

    found[meaning] = index;
    if (index !== -1) taken.add(index);
  }

  return found;
}

/* ------------------------------------------------------------------ dates */

/**
 * Parse a date from a statement cell.
 *
 * Banks write dates as 2026-06-01, 01/06/2026, 01-Jun-2026 and 1 Jun 2026. The
 * ambiguity that matters is dd/mm vs mm/dd: for a Nigerian statement the day
 * comes first, and guessing the other way silently shifts a payment by months.
 * So a slash date is read day-first, and anything that cannot be read returns
 * null rather than a plausible-looking wrong day.
 */
export function parseStatementDate(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;

  // ISO: 2026-06-01, optionally with a time.
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [, y, m, d] = iso;
    const ts = Date.UTC(Number(y), Number(m) - 1, Number(d));
    return Number.isFinite(ts) ? ts : null;
  }

  // Day-first with slashes or dots: 01/06/2026, 1.6.2026.
  const dmy = text.match(/^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/);
  if (dmy) {
    let [, d, m, y] = dmy;
    if (y.length === 2) y = `20${y}`;
    const ts = Date.UTC(Number(y), Number(m) - 1, Number(d));
    // Reject 31/02 — a date the bank could not have written means the columns
    // were misread, and a silently rolled-over date is worse than a rejection.
    const check = new Date(ts);
    if (check.getUTCDate() !== Number(d) || check.getUTCMonth() !== Number(m) - 1) return null;
    return ts;
  }

  // 01-Jun-2026 / 1 June 2026
  const named = text.match(/^(\d{1,2})[-\s]([A-Za-z]{3,})[-\s](\d{2,4})$/);
  if (named) {
    const [, d, monthName, yRaw] = named;
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const m = months.indexOf(monthName.slice(0, 3).toLowerCase());
    if (m === -1) return null;
    const y = yRaw.length === 2 ? `20${yRaw}` : yRaw;
    return Date.UTC(Number(y), m, Number(d));
  }

  return null;
}

/* ------------------------------------------------------------------ import */

/**
 * Read a statement into normalised transactions.
 *
 * Returns `{ transactions, rejected, columns }`. Nothing is written to the
 * database here — this is pure, so it can be tested against real exports and
 * inspected before anything touches the ledger.
 *
 * @param {string} text      the CSV contents
 * @param {object} options   { currency, overrides, source }
 */
export function parseStatement(text, { currency = 'NGN', overrides = {} } = {}) {
  const rows = parseCsv(text);
  if (rows.length === 0) return { transactions: [], rejected: [], columns: {} };

  const headers = rows[0];
  const columns = { ...detectColumns(headers), ...overrides };

  if (columns.date === -1 || columns.date === undefined) {
    throw new Error(`no date column found. Headers were: ${headers.join(' | ')}`);
  }
  const hasAmount = columns.amount !== undefined && columns.amount !== -1;
  const hasSigned = columns.signedAmount !== undefined && columns.signedAmount !== -1;
  if (!hasAmount && !hasSigned) {
    throw new Error(`no amount column found. Headers were: ${headers.join(' | ')}`);
  }

  const transactions = [];
  const rejected = [];

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    const cell = (index) => (index === undefined || index === -1 ? '' : String(row[index] ?? '').trim());

    const receivedOn = parseStatementDate(cell(columns.date));
    if (receivedOn === null) {
      rejected.push({ line: r + 1, reason: `unreadable date: "${cell(columns.date)}"`, raw: row });
      continue;
    }

    const descriptor = cell(columns.descriptor);
    const reference = cell(columns.reference);

    // Direction. Three shapes exist and all three have to work:
    //   a) separate credit and debit columns
    //   b) one signed amount column
    //   c) one amount column plus a type column saying DR/CR
    let amountMinor = null;
    let direction = null;

    if (hasAmount) {
      const credit = cell(columns.amount);
      const debit = cell(columns.debit);
      if (credit) {
        // The same column can carry both directions. A single "Amount" column is
        // the most common shape outside Nigeria's big banks, and the direction is
        // in the sign: -20000 or (20000) is money out. Reading it as a positive
        // inflow would credit a client who never paid.
        const negative = /^-/.test(credit.trim()) || /^\(.*\)$/.test(credit.trim());
        const cleaned = credit.replace(/[()]/g, '').replace(/^-/, '');
        try {
          amountMinor = parseAmount(cleaned, currency);
          direction = negative ? 'out' : 'in';
        } catch { /* reported below */ }
      }
      if (amountMinor === null && debit) {
        try { amountMinor = parseAmount(debit, currency); direction = 'out'; } catch { /* reported below */ }
      }
      if (amountMinor === null && credit) {
        rejected.push({ line: r + 1, reason: `unreadable amount: "${credit}"`, raw: row });
        continue;
      }
    } else if (hasSigned) {
      const raw = cell(columns.signedAmount);
      const negative = /^-|\(.*\)/.test(raw);
      const cleaned = raw.replace(/[()]/g, '').replace(/^-/, '');
      try {
        amountMinor = parseAmount(cleaned, currency);
        direction = negative ? 'out' : 'in';
      } catch {
        rejected.push({ line: r + 1, reason: `unreadable amount: "${raw}"`, raw: row });
        continue;
      }
    }

    // A type column overrides the sign, because some exports write every amount
    // as a positive number and mark direction separately.
    const typeCell = cell(columns.type).toUpperCase();
    if (typeCell === 'DR' || typeCell.includes('DEBIT')) direction = 'out';
    if (typeCell === 'CR' || typeCell.includes('CREDIT')) direction = 'in';

    if (amountMinor === null || amountMinor === 0) {
      rejected.push({ line: r + 1, reason: 'no amount on this row', raw: row });
      continue;
    }

    transactions.push({
      line: r + 1,
      receivedOn,
      amountMinor,
      direction: direction || 'in',
      descriptor,
      reference: reference || null,
      // The identity used for de-duplication. Without a bank reference, the
      // date+amount+descriptor triple is the best available fingerprint, and it
      // is stable across re-imports of the same file.
      externalRef: reference || `${receivedOn}:${amountMinor}:${descriptor.slice(0, 80)}`,
    });
  }

  return { transactions, rejected, columns, headers };
}

/** Only the inflows, which are the only rows that can settle an invoice. */
export function creditsOnly(transactions) {
  return transactions.filter((t) => t.direction === 'in');
}
