// Templates must never lie about the date.
//
// The bug these tests exist for: a step scheduled for the due date gets claimed
// six days later because the scheduler was down, and the client receives "this
// is due today" for an invoice that is already overdue. That single lie makes
// every later message less believable, so the wording has to follow the
// invoice's actual state rather than the step's original intent.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TEMPLATES,
  honestTemplateKey,
  render,
  templateVariables,
  daysLateFor,
  INTERNAL_TEMPLATES,
} from '../src/templates.mjs';

const DAY = 24 * 60 * 60 * 1000;
const DUE = Date.UTC(2026, 9, 15);

const invoice = {
  number: 'INV-0002',
  amount_minor: 120000000,
  outstandingMinor: 120000000,
  currency: 'NGN',
  due_on: DUE,
  issued_on: DUE - 30 * DAY,
};

const vars = (now) =>
  templateVariables({
    invoice,
    clientName: 'Chinedu Eze',
    now,
    formatter: (minor, currency) => `₦${(minor / 100).toLocaleString('en-NG')}`,
  });

/* --------------------------------------------------------------- honesty */

test('a day before due picks the heads-up wording', () => {
  assert.equal(honestTemplateKey(-1), 'heads_up');
});

test('the due date itself picks the due-today wording', () => {
  assert.equal(honestTemplateKey(0), 'due_today');
});

test('one day late already picks the late wording, not "due today"', () => {
  assert.equal(honestTemplateKey(1), 'late_gentle');
});

test('six days late picks the late wording', () => {
  // This is the exact case that shipped wrong.
  assert.equal(honestTemplateKey(6), 'late_gentle');
});

test('two weeks late picks the firm wording', () => {
  assert.equal(honestTemplateKey(14), 'late_firm');
  assert.equal(honestTemplateKey(29), 'late_firm');
});

test('a month late picks the escalation wording', () => {
  assert.equal(honestTemplateKey(30), 'late_escalate');
  assert.equal(honestTemplateKey(400), 'late_escalate');
});

test('the honest key is never the internal flag template', () => {
  for (let days = -10; days <= 400; days += 1) {
    assert.equal(INTERNAL_TEMPLATES.has(honestTemplateKey(days)), false, `day ${days}`);
  }
});

test('every day-late value maps to exactly one template', () => {
  // No gaps: a client must never fall through to silence because the ranges
  // do not tile the number line.
  for (let days = -30; days <= 500; days += 1) {
    const key = honestTemplateKey(days);
    const template = TEMPLATES[key];
    assert.ok(
      days >= template.minDaysLate && days <= template.maxDaysLate,
      `day ${days} mapped to ${key}, whose range is ${template.minDaysLate}..${template.maxDaysLate}`,
    );
  }
});

/* ------------------------------------------------------------- rendering */

test('a six-day-late invoice never renders the phrase "due today"', () => {
  const body = render(honestTemplateKey(6), vars(DUE + 6 * DAY));

  assert.equal(body.includes('due today'), false, body);
  assert.ok(body.includes('6 days ago'), body);
});

test('an invoice due today does say "due today"', () => {
  const body = render(honestTemplateKey(0), vars(DUE));

  assert.ok(body.includes('due today'), body);
});

test('a future invoice does not claim to be late', () => {
  const body = render(honestTemplateKey(-2), vars(DUE - 2 * DAY));

  assert.equal(body.toLowerCase().includes('overdue'), false, body);
  assert.equal(body.includes('days ago'), false, body);
});

/* ------------------------------------------------------------- variables */

test('days late is floored at zero for a future invoice', () => {
  assert.equal(daysLateFor(DUE, DUE - 5 * DAY), 0);
  assert.equal(daysLateFor(DUE, DUE), 0);
  assert.equal(daysLateFor(DUE, DUE + 3 * DAY), 3);
});

test('rendering leaves unknown variables visible rather than blanking them', () => {
  // A missing value must be obvious in the message, not silently absent.
  const body = render('due_today', { client: 'Ada' });
  assert.ok(body.includes('{{number}}'), body);
  assert.ok(body.includes('{{amount}}'), body);
});

test('an unknown template is an error, not a silent empty message', () => {
  assert.throws(() => render('does_not_exist', {}), /unknown template/);
});

test('the amount in the message is the outstanding figure, not the total', () => {
  const variables = templateVariables({
    invoice: { ...invoice, outstandingMinor: 50000000 },
    clientName: 'Ada',
    now: DUE,
    formatter: (minor) => `₦${minor / 100}`,
  });

  assert.equal(variables.amount, '₦500000');
  assert.equal(variables.total, '₦1200000');
});
