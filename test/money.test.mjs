import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount, formatAmount, exponent, sum, isValidAmount } from '../src/money.mjs';

test('amounts parse to integer minor units', () => {
  assert.equal(parseAmount('1200', 'NGN'), 120000);
  assert.equal(parseAmount('1200.50', 'NGN'), 120050);
  assert.equal(parseAmount('1,200.50', 'NGN'), 120050);
  assert.equal(parseAmount('₦1,200.50', 'NGN'), 120050);
  assert.equal(parseAmount('0.01', 'NGN'), 1);
});

test('a currency with no minor unit keeps integers whole', () => {
  assert.equal(exponent('XOF'), 0);
  assert.equal(parseAmount('1200', 'XOF'), 1200);
  // A franc has no subunit, so a decimal is an error rather than a rounding.
  assert.throws(() => parseAmount('1200.5', 'XOF'), /too many decimal places/);
});

test('too much precision is refused, never rounded', () => {
  // 1 kobo cannot be split. Rounding here would invent money.
  assert.throws(() => parseAmount('1200.505', 'NGN'), /too many decimal places/);
});

test('nonsense input is refused', () => {
  for (const input of ['', 'abc', '12.34.56', '1,2,3.4.5', null, undefined, {}, '1e5']) {
    assert.throws(() => parseAmount(input, 'NGN'), String(input));
  }
});

test('negative amounts are refused', () => {
  assert.throws(() => parseAmount(-100, 'NGN'), /invalid amount/);
  assert.throws(() => parseAmount('-100', 'NGN'), /invalid amount/);
});

test('an unknown currency is refused rather than assumed to have 2 places', () => {
  assert.throws(() => parseAmount('100', 'XYZ'), /unsupported currency/);
  assert.throws(() => exponent('XYZ'), /unsupported currency/);
});

test('formatting round-trips', () => {
  const cases = [
    ['1200.50', 'NGN'],
    ['0.01', 'NGN'],
    ['1234567.89', 'NGN'],
    ['500', 'USD'],
  ];

  for (const [input, currency] of cases) {
    const minor = parseAmount(input, currency);
    const formatted = formatAmount(minor, currency, { symbol: false });
    assert.equal(parseAmount(formatted, currency), minor, `${input} ${currency} -> ${formatted}`);
  }
});

test('formatting includes the symbol and separators', () => {
  assert.equal(formatAmount(120050, 'NGN'), '₦1,200.50');
  assert.equal(formatAmount(100, 'NGN'), '₦1.00');
  assert.equal(formatAmount(0, 'NGN'), '₦0.00');
});

test('negative formatting keeps the sign outside the symbol', () => {
  assert.equal(formatAmount(-120050, 'NGN'), '-₦1,200.50');
});

test('summing rejects non-integers', () => {
  assert.equal(sum([100, 200, 300], 'NGN'), 600);
  assert.throws(() => sum([100.5], 'NGN'), /integer/);
});

test('validity check catches bad amounts', () => {
  assert.equal(isValidAmount(100, 'NGN'), true);
  assert.equal(isValidAmount(0, 'NGN'), true);
  assert.equal(isValidAmount(-1, 'NGN'), false);
  assert.equal(isValidAmount(1.5, 'NGN'), false);
  assert.equal(isValidAmount(100, 'XYZ'), false);
});
