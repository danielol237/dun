// Statements: reading a bank export without inventing anything.
//
// The failures these cover are all the same shape — a number that looks right and
// is not:
//
//   - a date read month-first on a Nigerian statement, shifting a payment by
//     months and quietly un-paying an invoice
//   - a narration with a comma in it, splitting the row and losing the name of
//     the person who paid
//   - a debit recorded as a payment, crediting a client who never paid
//   - the same file imported twice, so the payment counts twice and the client is
//     chased after paying
//
// Every one of them ends in the same place: a client asked for money they already
// sent. So the parser is strict, and a row it cannot read is reported rather than
// coerced.

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseCsv, detectColumns, parseStatementDate, parseStatement, creditsOnly } from '../src/statement.mjs';

const T0 = Date.UTC(2026, 5, 1);

/* ── CSV ──────────────────────────────────────────────────────────────────── */

test('a plain CSV parses into rows', () => {
  const rows = parseCsv('a,b,c\n1,2,3\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['1', '2', '3']]);
});

test('a quoted field containing a comma stays one field', () => {
  // This is the real one. A narration like "TRANSFER, ADA OBI" splits the row
  // with a naive parser, and the column that says who paid becomes two columns.
  const rows = parseCsv('date,narration,amount\n01/06/2026,"TRANSFER, ADA OBI",450000\n');
  assert.equal(rows[1][1], 'TRANSFER, ADA OBI');
  assert.equal(rows[1].length, 3);
});

test('a quoted field containing a newline stays one field', () => {
  // Bank exports do this in the narration column, and it silently shifts every
  // subsequent row by one if the parser reads line by line.
  const rows = parseCsv('date,narration,amount\n01/06/2026,"line one\nline two",450000\n');
  assert.equal(rows[1][1], 'line one\nline two');
  assert.equal(rows.length, 2);
});

test('an escaped quote inside a quoted field is unescaped', () => {
  const rows = parseCsv('a,b\n"say ""hi""",2\n');
  assert.equal(rows[1][0], 'say "hi"');
});

test('a UTF-8 BOM does not corrupt the first header', () => {
  // Excel writes one. Left in place, the first header becomes "\uFEFFDate" and
  // stops matching any synonym, so the whole import fails on a file that looks
  // perfectly normal.
  const rows = parseCsv('\uFEFFdate,amount\n01/06/2026,500\n');
  assert.equal(rows[0][0], 'date');
});

test('blank lines are skipped, not turned into empty rows', () => {
  const rows = parseCsv('a,b\n1,2\n\n3,4\n');
  assert.equal(rows.length, 3);
});

/* ── Dates ────────────────────────────────────────────────────────────────── */

test('an ISO date parses', () => {
  assert.equal(parseStatementDate('2026-06-01'), Date.UTC(2026, 5, 1));
});

test('a slashed date is read day-first', () => {
  // 01/06/2026 is 1 June in Nigeria. Read month-first it becomes 6 January — a
  // payment that arrives five months before the invoice existed, which then fails
  // to match anything and looks like a data problem rather than a date bug.
  assert.equal(parseStatementDate('01/06/2026'), Date.UTC(2026, 5, 1));
  assert.equal(parseStatementDate('13/06/2026'), Date.UTC(2026, 5, 13));
});

test('a two-digit year is read as this century', () => {
  assert.equal(parseStatementDate('01/06/26'), Date.UTC(2026, 5, 1));
});

test('a named month parses', () => {
  assert.equal(parseStatementDate('01-Jun-2026'), Date.UTC(2026, 5, 1));
  assert.equal(parseStatementDate('1 June 2026'), Date.UTC(2026, 5, 1));
});

test('an impossible date is rejected rather than rolled over', () => {
  // 31 February would become 3 March if handed to Date. A date the bank could not
  // have written means the columns were misread, and a silently shifted date is
  // worse than a rejection.
  assert.equal(parseStatementDate('31/02/2026'), null);
  assert.equal(parseStatementDate('99/99/2026'), null);
});

test('nonsense is rejected', () => {
  assert.equal(parseStatementDate('not-a-date'), null);
  assert.equal(parseStatementDate(''), null);
  assert.equal(parseStatementDate(null), null);
});

/* ── Column detection ─────────────────────────────────────────────────────── */

test('columns are found by meaning, not by position', () => {
  // GTBank's order, then Kuda's. The same facts, different layout.
  const gt = detectColumns(['Transaction Date', 'Narration', 'Credit', 'Debit', 'Reference']);
  assert.equal(gt.date, 0);
  assert.equal(gt.descriptor, 1);
  assert.equal(gt.amount, 2);
  assert.equal(gt.debit, 3);
  assert.equal(gt.reference, 4);

  const kuda = detectColumns(['Date', 'Description', 'Amount', 'Balance']);
  assert.equal(kuda.date, 0);
  assert.equal(kuda.descriptor, 1);
  assert.equal(kuda.amount, 2);
  assert.equal(kuda.balance, 3);
});

test('a more specific header wins over a general one', () => {
  // With both "Credit" and "Amount" present, claiming "Amount" first would read
  // the wrong column and flip the sign on every payment.
  const columns = detectColumns(['Value Date', 'Details', 'Credit Amount', 'Amount']);
  assert.equal(columns.amount, 2, 'Credit Amount must win over Amount');
});

test('an unfamiliar header is simply unused, not fatal', () => {
  const columns = detectColumns(['Date', 'Amount', 'Some Weird Column']);
  assert.equal(columns.date, 0);
  assert.equal(columns.amount, 1);
  assert.equal(columns.balance, -1);
});

/* ── Whole statements ─────────────────────────────────────────────────────── */

test('a credit and a debit are told apart', () => {
  const csv = [
    'Transaction Date,Narration,Credit,Debit,Reference',
    '01/06/2026,TRANSFER FROM ADA,450000.00,,GT1',
    '02/06/2026,ATM WITHDRAWAL,,20000.00,GT2',
  ].join('\n');

  const { transactions } = parseStatement(csv, { currency: 'NGN' });
  assert.equal(transactions.length, 2);

  assert.equal(transactions[0].direction, 'in');
  assert.equal(transactions[0].amountMinor, 45000000);

  assert.equal(transactions[1].direction, 'out');
  assert.equal(transactions[1].amountMinor, 2000000);

  // Only the inflow can settle an invoice.
  assert.equal(creditsOnly(transactions).length, 1);
});

test('a signed amount column is read as direction', () => {
  const csv = [
    'Date,Description,Amount',
    '01/06/2026,TRANSFER IN,450000.00',
    '02/06/2026,TRANSFER OUT,-20000.00',
  ].join('\n');

  const { transactions } = parseStatement(csv, { currency: 'NGN' });
  assert.equal(transactions[0].direction, 'in');
  assert.equal(transactions[1].direction, 'out');
  assert.equal(transactions[1].amountMinor, 2000000, 'the sign is direction, not a negative amount');
});

test('a type column overrides the sign', () => {
  // Some exports write every amount positive and mark direction separately.
  const csv = [
    'Date,Description,Amount,Type',
    '01/06/2026,PAYMENT RECEIVED,450000.00,CR',
    '02/06/2026,TRANSFER OUT,20000.00,DR',
  ].join('\n');

  const { transactions } = parseStatement(csv, { currency: 'NGN' });
  assert.equal(transactions[0].direction, 'in');
  assert.equal(transactions[1].direction, 'out');
});

test('an unreadable row is reported with its line number, not dropped', () => {
  // A statement that imports 39 of 40 rows and says which one it could not read
  // is usable. One that silently drops it is a reconciliation bug discovered
  // months later.
  const csv = [
    'Date,Narration,Credit,Reference',
    '01/06/2026,GOOD ROW,450000.00,GT1',
    'not-a-date,BAD ROW,500.00,GT2',
    '03/06/2026,ANOTHER GOOD ROW,1000.00,GT3',
  ].join('\n');

  const { transactions, rejected } = parseStatement(csv, { currency: 'NGN' });
  assert.equal(transactions.length, 2);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].line, 3, 'the reported line must point at the bad row');
  assert.match(rejected[0].reason, /unreadable date/i);
});

test('an unreadable amount is reported, not turned into zero', () => {
  const csv = [
    'Date,Narration,Credit,Reference',
    '01/06/2026,WEIRD AMOUNT,abc,GT1',
  ].join('\n');

  const { transactions, rejected } = parseStatement(csv, { currency: 'NGN' });
  assert.equal(transactions.length, 0);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0].reason, /unreadable amount/i);
});

test('a statement with no date column fails loudly and says what it saw', () => {
  // Failing with the actual headers is the difference between a five-second fix
  // and an afternoon of guessing.
  assert.throws(
    () => parseStatement('Foo,Bar\n1,2\n', { currency: 'NGN' }),
    /no date column found.*Foo.*Bar/i,
  );
});

test('a statement with no amount column fails loudly', () => {
  assert.throws(
    () => parseStatement('Date,Narration\n01/06/2026,x\n', { currency: 'NGN' }),
    /no amount column found/i,
  );
});

test('the external reference is the bank reference when there is one', () => {
  const csv = [
    'Date,Narration,Credit,Reference',
    '01/06/2026,TRANSFER,450000.00,GT-ABC-123',
  ].join('\n');

  const { transactions } = parseStatement(csv, { currency: 'NGN' });
  assert.equal(transactions[0].externalRef, 'GT-ABC-123');
});

test('without a bank reference, the fingerprint is stable across re-parses', () => {
  // Re-importing the same file must not create a second payment. With no
  // reference to key on, the fingerprint has to be deterministic.
  const csv = 'Date,Narration,Credit\n01/06/2026,TRANSFER FROM ADA,450000.00\n';
  const first = parseStatement(csv, { currency: 'NGN' });
  const second = parseStatement(csv, { currency: 'NGN' });

  assert.equal(first.transactions[0].externalRef, second.transactions[0].externalRef);
  assert.ok(first.transactions[0].externalRef.includes('45000000'));
});

test('amounts are integer minor units, never floats', () => {
  // The whole ledger depends on this. A float here becomes a kobo of drift that
  // surfaces as "you still owe ₦0.01".
  const csv = 'Date,Narration,Credit\n01/06/2026,X,"1,200.50"\n';
  const { transactions } = parseStatement(csv, { currency: 'NGN' });
  assert.equal(transactions[0].amountMinor, 120050);
  assert.equal(Number.isInteger(transactions[0].amountMinor), true);
});
