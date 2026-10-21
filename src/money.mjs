// Money.
//
// Every amount in this system is an integer in minor units. There is exactly
// one place in the codebase that knows how many minor units a currency has,
// and it is here. Everything else passes integers around and never divides.
//
// The reason is not pedantry. A chase system that rounds a kobo the wrong way
// tells a client they still owe ₦0.01, and that single kobo becomes a support
// conversation and a reason not to pay.

/** Minor units per major unit, for the currencies this system supports. */
const EXPONENTS = {
  NGN: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  INR: 2,
  XOF: 0, // West African CFA franc has no minor unit
  JPY: 0,
};

export function exponent(currency) {
  const code = String(currency ?? '').toUpperCase();
  const value = EXPONENTS[code];
  if (value === undefined) {
    throw new Error(`unsupported currency: ${currency}`);
  }
  return value;
}

/**
 * Parse a human amount into minor units.
 *
 * Accepts "1,200.50", "1200.5", "1200", 1200, "₦1,200.50".
 * Rejects anything that is not a clean amount rather than coercing it — a
 * parse that guesses is how a ledger acquires a wrong number it can never
 * explain.
 */
export function parseAmount(input, currency) {
  const places = exponent(currency);

  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) throw new Error('invalid amount');
    // A float input is accepted only when it is exactly representable at the
    // currency's precision; otherwise the caller has already lost the value.
    return Math.round(input * 10 ** places);
  }

  if (typeof input !== 'string') throw new Error('invalid amount');

  const cleaned = input
    .replace(/[₦$€£¥]/g, '')
    .replace(/\s/g, '')
    .replace(/,/g, '');

  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw new Error(`invalid amount: ${input}`);

  const [whole, fraction = ''] = cleaned.split('.');

  if (fraction.length > places) {
    // More precision than the currency has. Truncating silently would lose
    // money; rounding would invent it. Refuse.
    throw new Error(`too many decimal places for ${currency}: ${input}`);
  }

  const padded = fraction.padEnd(places, '0');
  const value = Number(whole) * 10 ** places + Number(padded || '0');

  if (!Number.isSafeInteger(value)) throw new Error(`amount out of range: ${input}`);
  return value;
}

/** Format minor units for display. */
export function formatAmount(minor, currency, { symbol = true } = {}) {
  const places = exponent(currency);
  const negative = minor < 0;
  const absolute = Math.abs(minor);

  const whole = Math.floor(absolute / 10 ** places);
  const fraction = absolute % 10 ** places;

  const wholeText = whole.toLocaleString('en-NG');

  const fractionText = places === 0
    ? ''
    : `.${String(fraction).padStart(places, '0')}`;

  const symbols = { NGN: '₦', USD: '$', EUR: '€', GBP: '£', GHS: '₵', KES: 'KSh', ZAR: 'R', INR: '₹' };
  const prefix = symbol ? (symbols[String(currency).toUpperCase()] ?? `${currency} `) : '';

  return `${negative ? '-' : ''}${prefix}${wholeText}${fractionText}`;
}

/** Sum, refusing to mix currencies. */
export function sum(amounts, currency) {
  let total = 0;
  for (const amount of amounts) {
    if (!Number.isInteger(amount)) throw new Error('amount must be an integer');
    total += amount;
  }
  if (!Number.isSafeInteger(total)) throw new Error('sum overflow');
  return total;
}

/** True when an amount is a valid minor-unit value for the currency. */
export function isValidAmount(minor, currency) {
  if (!Number.isSafeInteger(minor) || minor < 0) return false;
  try {
    exponent(currency);
  } catch {
    return false;
  }
  return true;
}
