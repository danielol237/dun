#!/usr/bin/env node
// dun — the command line.
//
// The whole product is usable from here. That is deliberate: a collections
// tool that requires a dashboard before it does anything is a dashboard, not a
// tool. Everything the web layer would do is a subcommand, and the web layer
// (when it exists) will call exactly these functions.

import { Db } from '../src/db.mjs';
import { Ledger } from '../src/ledger.mjs';
import { parseAmount, formatAmount } from '../src/money.mjs';
import {
  createClient,
  createInvoice,
  getInvoice,
  recordPayment,
  voidInvoice,
  openInvoices,
  dayStart,
  addDays,
  findPartyByHandle,
  allocate,
} from '../src/domain.mjs';
import { tick, onPaymentRecorded, checkInvariants } from '../src/scheduler.mjs';
import { channelsFromEnv } from '../src/channels.mjs';
import { dispatch, outboxHealth } from '../src/delivery.mjs';
import { importStatement } from '../src/import.mjs';
import { reviewQueue } from '../src/matcher.mjs';

const DB_PATH = process.env.DUN_DB ?? 'data/dun.db';

const [, , command, ...args] = process.argv;

function flag(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
}

function positional() {
  const out = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      i += 1;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

const fmtDate = (ts) => new Date(ts).toISOString().slice(0, 10);

async function withDb(fn) {
  const db = await Db.open(DB_PATH);
  try {
    const result = await fn(db);
    await db.flush();
    return result;
  } finally {
    await db.close();
  }
}

const commands = {
  async init() {
    await withDb(async () => {});
    console.log(`database ready at ${DB_PATH}`);
  },

  /* ---------------------------------------------------------------- clients */

  async client() {
    const [name] = positional();
    const whatsapp = flag('whatsapp');
    const email = flag('email');

    if (!name) throw new Error('usage: dun client <name> [--whatsapp +234...] [--email a@b.com]');

    await withDb(async (db) => {
      const handles = [];
      if (whatsapp) handles.push({ channel: 'whatsapp', value: whatsapp });
      if (email) handles.push({ channel: 'email', value: email });

      const id = createClient(db, { displayName: name, handles });
      console.log(`client #${id} ${name}`);
    });
  },

  async clients() {
    await withDb(async (db) => {
      const rows = db.rows(`
        SELECT p.id, p.display_name,
               GROUP_CONCAT(h.channel || ':' || h.value, '  ') AS handles
          FROM party p
          LEFT JOIN party_handle h ON h.party_id = p.id
         WHERE p.kind = 'client'
         GROUP BY p.id
         ORDER BY p.display_name
      `);

      if (rows.length === 0) return console.log('no clients yet');

      for (const row of rows) {
        console.log(`${String(row.id).padStart(3)}  ${row.display_name.padEnd(24)} ${row.handles ?? ''}`);
      }
    });
  },

  /* --------------------------------------------------------------- invoices */

  async invoice() {
    const [clientRef, amountArg] = positional();
    const currency = flag('currency', 'NGN');
    const number = flag('number');
    const dueDays = Number(flag('due-days', '14'));
    const issued = flag('issued');

    if (!clientRef || !amountArg) {
      throw new Error('usage: dun invoice <client-id|name> <amount> [--number INV-1] [--due-days 14] [--currency NGN]');
    }

    await withDb(async (db) => {
      const client = resolveClient(db, clientRef);
      const amountMinor = parseAmount(amountArg, currency);
      const issuedOn = issued ? dayStart(issued) : dayStart(Date.now());

      const invNumber = number ?? nextNumber(db);

      const id = createInvoice(db, {
        number: invNumber,
        clientId: client.id,
        currency,
        amountMinor,
        issuedOn,
        dueOn: addDays(issuedOn, dueDays),
      });

      const invoice = getInvoice(db, id);
      console.log(`invoice ${invoice.number}  ${formatAmount(invoice.amount_minor, currency)}  due ${fmtDate(invoice.due_on)}  -> ${client.display_name}`);
    });
  },

  async open() {
    await withDb(async (db) => {
      const rows = openInvoices(db);
      if (rows.length === 0) return console.log('nothing outstanding');

      const today = dayStart(Date.now());

      for (const row of rows) {
        const daysLate = Math.floor((today - row.due_on) / (24 * 60 * 60 * 1000));
        const status = daysLate > 0 ? `${daysLate}d late` : daysLate === 0 ? 'due today' : `in ${-daysLate}d`;

        console.log(
          `${row.number.padEnd(12)} ${row.client_name.padEnd(20)} ` +
          `${formatAmount(row.outstanding_minor, row.currency).padStart(14)}  ${status}`,
        );
      }
    });
  },

  async pay() {
    const [clientRef, amountArg] = positional();
    const currency = flag('currency', 'NGN');
    const invoiceNumber = flag('invoice');
    const descriptor = flag('descriptor');

    if (!clientRef || !amountArg) {
      throw new Error('usage: dun pay <client-id|name> <amount> [--invoice INV-1] [--descriptor "bank narrative"]');
    }

    await withDb(async (db) => {
      const client = resolveClient(db, clientRef);
      const amountMinor = parseAmount(amountArg, currency);
      const receivedOn = dayStart(flag('on') ?? Date.now());

      // Explicit allocation only. Auto-matching by amount is how a payment
      // lands on the wrong invoice of two identical ones.
      let allocations = [];

      if (invoiceNumber) {
        const invoice = db.row('SELECT * FROM invoice WHERE number = ?', [invoiceNumber]);
        if (!invoice) throw new Error(`unknown invoice: ${invoiceNumber}`);
        if (invoice.client_id !== client.id) throw new Error('that invoice belongs to a different client');

        const detail = getInvoice(db, invoice.id);
        allocations = [{ invoiceId: invoice.id, amountMinor: Math.min(amountMinor, detail.outstandingMinor) }];
      } else {
        // Oldest first, still explicit, and only across this client's own
        // invoices — which is a rule, not a guess.
        let remaining = amountMinor;
        const queue = openInvoices(db).filter(
          (row) => row.client_id === client.id && row.currency === currency,
        );

        for (const row of queue) {
          if (remaining <= 0) break;
          const take = Math.min(remaining, row.outstanding_minor);
          allocations.push({ invoiceId: row.id, amountMinor: take });
          remaining -= take;
        }
      }

      const paymentId = recordPayment(db, {
        clientId: client.id,
        currency,
        amountMinor,
        receivedOn,
        source: 'manual',
        rawDescriptor: descriptor,
        allocations,
      });

      onPaymentRecorded(db, { clientId: client.id, currency });

      const allocated = allocations.reduce((total, a) => total + a.amountMinor, 0);
      console.log(`payment #${paymentId} ${formatAmount(amountMinor, currency)} from ${client.display_name}`);
      console.log(`  allocated: ${formatAmount(allocated, currency)}`);
      if (amountMinor > allocated) {
        console.log(`  unallocated: ${formatAmount(amountMinor - allocated, currency)} (sits as a credit)`);
      }
    });
  },

  async void() {
    const [invoiceNumber] = positional();
    if (!invoiceNumber) throw new Error('usage: dun void <invoice-number> [--reason "..."]');

    await withDb(async (db) => {
      const invoice = db.row('SELECT * FROM invoice WHERE number = ?', [invoiceNumber]);
      if (!invoice) throw new Error(`unknown invoice: ${invoiceNumber}`);

      voidInvoice(db, invoice.id, { reason: flag('reason') });
      console.log(`voided ${invoiceNumber}`);
    });
  },

  /* --------------------------------------------------------------- chasing */

  async tick() {
    await withDb(async (db) => {
      const now = flag('now') ? Date.parse(flag('now')) : Date.now();
      const result = tick(db, { now });

      console.log(`reconciled ${result.invoices} invoices  +${result.created} reminders  -${result.cancelled} cancelled`);
      console.log(`claimed ${result.claimed}  queued ${result.queued}  skipped ${result.skipped}`);

      // Tick queues; it does not deliver. Sending is a separate pass because it
      // leaves the database — a network call inside the reconcile transaction
      // would hold a write lock for as long as a provider takes to answer, and a
      // provider that never answers would block every other writer.
      if (!flag('no-send')) {
        const channels = channelsFromEnv();
        const names = Object.keys(channels);
        if (names.length === 0) {
          console.log('no channels configured — queued messages will not send (see README: SMTP_*, WHATSAPP_*)');
        } else {
          const sent = await dispatch(db, { channels, now });
          console.log(`delivered ${sent.sent}  retrying ${sent.failed}  dead ${sent.dead}  (channels: ${names.join(', ')})`);
        }
      }
    });
  },

  /* -------------------------------------------------------------- delivery */

  /** Send whatever is queued, without advancing the schedule. */
  async send() {
    await withDb(async (db) => {
      const now = flag('now') ? Date.parse(flag('now')) : Date.now();
      const channels = channelsFromEnv();
      const names = Object.keys(channels);

      if (names.length === 0) {
        console.log('no channels configured. Set SMTP_* for email or WHATSAPP_* for WhatsApp, then retry.');
        return;
      }

      const result = await dispatch(db, { channels, now, limit: Number(flag('limit', 20)) });

      if (result.attempted === 0) {
        console.log('nothing to send');
        return;
      }

      console.log(`attempted ${result.attempted}  delivered ${result.sent}  retrying ${result.failed}  dead ${result.dead}`);
      for (const row of result.results) {
        const label = row.ok ? 'sent' : row.dead ? 'DEAD' : 'retry';
        const detail = row.ok ? (row.providerId ?? '') : row.error;
        console.log(`  #${String(row.id).padEnd(5)} ${label.padEnd(6)} ${String(detail).slice(0, 120)}`);
      }
    });
  },

  /** What is queued, stuck, or dead — and why. */
  async outbox() {
    await withDb(async (db) => {
      const now = Date.now();
      const health = outboxHealth(db, { now });

      const states = Object.entries(health.byState);
      if (states.length === 0) {
        console.log('outbox is empty');
        return;
      }

      console.log(states.map(([state, n]) => `${state} ${n}`).join('   '));
      console.log(`due now ${health.dueNow}`);

      if (health.oldestQueuedAt) {
        const hours = Math.round(health.oldestQueuedAgeMs / 3600000);
        console.log(`oldest queued ${hours}h ago`);
      }

      if (health.stuck.length > 0) {
        console.log('\nstuck:');
        for (const row of health.stuck) {
          console.log(`  #${String(row.id).padEnd(5)} ${row.channel.padEnd(9)} ${row.recipient}  tries ${row.attempts}`);
          if (row.last_error) console.log(`        ${String(row.last_error).slice(0, 140)}`);
        }
      }

      const channels = Object.keys(channelsFromEnv());
      console.log(`\nchannels: ${channels.length ? channels.join(', ') : 'none configured'}`);
    });
  },

  /** Show the message body that would be sent, without sending it. */
  async preview() {
    const [id] = positional();
    if (!id) throw new Error('usage: dun preview <outbox-id>');

    await withDb(async (db) => {
      const row = db.row('SELECT * FROM outbox_message WHERE id = ?', [Number(id)]);
      if (!row) throw new Error(`no outbox message #${id}`);

      console.log(`to       ${row.recipient}`);
      console.log(`channel  ${row.channel}`);
      console.log(`state    ${row.state}  attempts ${row.attempts}`);
      if (row.idempotency_key) console.log(`key      ${row.idempotency_key}`);
      console.log('---');
      console.log(row.body);
    });
  },

  /* --------------------------------------------------------------- banking */

  /**
   * Import a bank statement.
   *
   * Safe to run repeatedly: the bank's own reference is the identity, so
   * re-importing yesterday's file changes nothing.
   */
  async import() {
    const [file] = positional();
    if (!file) throw new Error('usage: dun import <statement.csv> [--currency NGN] [--source feed:gtbank]');

    const fs = await import('node:fs/promises');
    let text;
    try {
      text = await fs.readFile(file, 'utf8');
    } catch (err) {
      throw new Error(`could not read ${file}: ${err.message}`);
    }

    const currency = flag('currency', 'NGN');
    const source = flag('source', 'feed:manual');

    await withDb(async (db) => {
      const result = importStatement(db, text, { currency, source });

      console.log(`imported ${result.imported}  duplicates ${result.duplicates}  unattributed ${result.unattributed}  debits ignored ${result.debitsIgnored}`);

      if (result.rejected.length > 0) {
        console.log(`\n${result.rejected.length} row(s) could not be read:`);
        for (const row of result.rejected.slice(0, 10)) {
          console.log(`  line ${row.line}: ${row.reason}`);
        }
      }

      if (result.unattributed > 0) {
        console.log('\nsome credits could not be attributed to a client. Add the client, then re-import — it is safe to run again.');
      }

      // The proposals are the point of the import. Printing them here is what
      // turns a statement into a decision instead of a silent side effect.
      // A proposal with no invoiceId is an explanation, not a match — it exists
      // so the operator learns why nothing matched instead of assuming a bug.
      const proposals = result.payments.filter((p) => p.proposals.length > 0 && p.proposals[0].invoiceId !== null);
      const notes = result.payments.filter((p) => p.proposals.length > 0 && p.proposals[0].invoiceId === null);

      if (proposals.length > 0) {
        console.log('\nproposed matches (nothing is allocated until you confirm):');
        for (const { paymentId, proposals: ranked } of proposals) {
          const best = ranked[0];
          const mark = best.confident ? 'likely' : 'check';
          console.log(`  payment #${paymentId}  ${mark.padEnd(6)} ${best.number} ${best.clientName} — ${best.reasons[0]}`);
        }
        console.log('\nrun `dun review` to see them in full, then `dun allocate <payment> <invoice>`');
      }

      for (const { paymentId, proposals: ranked } of notes) {
        console.log(`\npayment #${paymentId} could not be matched:`);
        for (const reason of ranked[0].reasons) console.log(`  ! ${reason}`);
      }
    });
  },

  /** Money that arrived and has not been credited to an invoice. */
  async review() {
    await withDb(async (db) => {
      const queue = reviewQueue(db);

      if (queue.length === 0) {
        console.log('nothing to review — every payment is allocated');
        return;
      }

      for (const payment of queue) {
        console.log(
          `payment #${payment.id}  ${formatAmount(payment.unallocatedMinor, payment.currency)}  ` +
          `${payment.client_name}  ${fmtDate(payment.received_on)}`,
        );
        if (payment.raw_descriptor) console.log(`  "${payment.raw_descriptor}"`);

        if (payment.proposals.length === 0) {
          console.log('  no open invoice matches — allocate manually if you know which');
        } else if (payment.proposals[0].invoiceId === null) {
          // An explanation rather than a proposal: there is nothing to confirm.
          for (const reason of payment.proposals[0].reasons) console.log(`  ! ${reason}`);
        } else {
          for (const p of payment.proposals.slice(0, 3)) {
            const mark = p.confident ? 'LIKELY' : '  ?   ';
            console.log(`  ${mark} ${p.number} ${p.clientName} ${formatAmount(p.outstandingMinor, payment.currency)}  (score ${p.score})`);
            for (const reason of p.reasons) console.log(`         · ${reason}`);
          }
        }
        console.log('');
      }

      console.log('confirm with: dun allocate <payment-id> <invoice-number> [amount]');
    });
  },

  /** Confirm a proposed match. The only place an allocation happens. */
  async allocate() {
    const [paymentArg, invoiceNumber, amountArg] = positional();
    if (!paymentArg || !invoiceNumber) {
      throw new Error('usage: dun allocate <payment-id> <invoice-number> [amount]');
    }

    await withDb(async (db) => {
      const payment = db.row('SELECT * FROM payment WHERE id = ?', [Number(paymentArg)]);
      if (!payment) throw new Error(`no payment #${paymentArg}`);

      const invoice = db.row('SELECT * FROM invoice WHERE number = ?', [invoiceNumber]);
      if (!invoice) throw new Error(`no invoice ${invoiceNumber}`);

      const unallocated = payment.amount_minor - db.value(
        'SELECT COALESCE(SUM(amount_minor), 0) FROM allocation WHERE payment_id = ?',
        [payment.id],
      );
      if (unallocated <= 0) throw new Error(`payment #${payment.id} is already fully allocated`);

      // Default to settling the invoice as far as this payment can, which is what
      // a confirmation means in the ordinary case.
      const outstanding = invoice.amount_minor - db.value(
        'SELECT COALESCE(SUM(amount_minor), 0) FROM allocation WHERE invoice_id = ?',
        [invoice.id],
      );
      const amountMinor = amountArg
        ? parseAmount(amountArg, payment.currency)
        : Math.min(unallocated, outstanding);

      const result = allocate(db, payment.id, invoice.id, amountMinor);

      console.log(`allocated ${formatAmount(amountMinor, payment.currency)} of payment #${payment.id} to ${invoice.number}`);
      console.log(`invoice is now ${result.status}, ${formatAmount(result.outstandingMinor, payment.currency)} outstanding`);

      // A confirmation can complete the chase.
      if (result.outstandingMinor === 0) {
        const cancelled = onPaymentRecorded(db, {
          clientId: invoice.client_id,
          currency: invoice.currency,
        });
        if (cancelled.cancelled > 0) console.log(`cancelled ${cancelled.cancelled} pending reminder(s)`);
      }
    });
  },

  async plan() {
    const [invoiceNumber] = positional();
    if (!invoiceNumber) throw new Error('usage: dun plan <invoice-number>');

    await withDb(async (db) => {
      const invoice = db.row('SELECT * FROM invoice WHERE number = ?', [invoiceNumber]);
      if (!invoice) throw new Error(`unknown invoice: ${invoiceNumber}`);

      const detail = getInvoice(db, invoice.id);
      const { policy } = await import('../src/policy.mjs').then((m) => ({
        policy: m.selectPolicy(db, detail),
      }));

      if (!policy) return console.log('no policy matches this invoice');

      const { planInvoice } = await import('../src/policy.mjs');
      const { plan } = planInvoice(db, detail, { now: Date.now() });

      console.log(`policy: ${policy.name} v${policy.version}`);
      for (const entry of plan) {
        const state = entry.skipped ? `skip (${entry.skipReason})` : entry.due ? 'due' : 'pending';
        console.log(`  ${fmtDate(entry.scheduledFor)}  ${entry.templateKey.padEnd(16)} ${entry.channel.padEnd(10)} ${state}`);
      }
    });
  },

  async outbox() {
    await withDb(async (db) => {
      const rows = db.rows(
        `SELECT o.*, i.number FROM outbox_message o
           LEFT JOIN reminder r ON r.id = o.reminder_id
           LEFT JOIN invoice i ON i.id = r.invoice_id
          ORDER BY o.id DESC LIMIT 20`,
      );

      if (rows.length === 0) return console.log('outbox empty');

      for (const row of rows) {
        console.log(`[${row.state}] ${row.channel} -> ${row.recipient}  ${row.number ?? ''}`);
        console.log(`  ${row.body}`);
      }
    });
  },

  /* -------------------------------------------------------------- accounts */

  async balance() {
    await withDb(async (db) => {
      const ledger = new Ledger(db);
      const rows = ledger.totalOutstanding();

      if (rows.length === 0) return console.log('nothing outstanding');

      for (const row of rows) {
        console.log(`${row.currency}  ${formatAmount(row.balance_minor, row.currency)}`);
      }
    });
  },

  async check() {
    await withDb(async (db) => {
      const result = checkInvariants(db);
      console.log(result.ok ? 'ledger balanced' : 'LEDGER DOES NOT BALANCE');
      if (!result.ok) {
        console.log(JSON.stringify(result, null, 2));
        process.exitCode = 1;
      }
    });
  },

  help() {
    console.log(`dun — invoice chasing that runs itself

  dun init
  dun client <name> [--whatsapp N] [--email A]
  dun clients
  dun invoice <client> <amount> [--number INV-1] [--due-days 14] [--currency NGN]
  dun open
  dun pay <client> <amount> [--invoice INV-1] [--descriptor "..."]
  dun void <invoice> [--reason "..."]
  dun plan <invoice>
  dun tick [--now 2026-10-21]   reconcile, plan, and deliver
  dun send [--limit 20]         deliver what is queued
  dun outbox                    what is queued, stuck, or dead — and why
  dun preview <outbox-id>       the exact wording before it goes
  dun import <statement.csv>    [--currency NGN] [--source feed:gtbank]
  dun review                    money that arrived, unallocated, with proposals
  dun allocate <payment> <invoice> [amount]
  dun balance
  dun check

env: DUN_DB (default data/dun.db)
channels: SMTP_* email · WHATSAPP_* WhatsApp · CHANNEL_WEBHOOK_URL anything else`);
  },
};

/* ------------------------------------------------------------------ helpers */

function resolveClient(db, ref) {
  // Accepts an id or a name, because typing ids is a tax nobody should pay.
  if (/^\d+$/.test(ref)) {
    const byId = db.row("SELECT * FROM party WHERE id = ? AND kind = 'client'", [Number(ref)]);
    if (byId) return byId;
  }

  const byName = db.row(
    "SELECT * FROM party WHERE kind = 'client' AND lower(display_name) = lower(?)",
    [ref],
  );
  if (byName) return byName;

  const byHandle = findPartyByHandle(db, 'whatsapp', ref);
  if (byHandle) return byHandle;

  const partial = db.rows(
    "SELECT * FROM party WHERE kind = 'client' AND display_name LIKE ?",
    [`%${ref}%`],
  );
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`ambiguous client: ${ref}`);

  throw new Error(`unknown client: ${ref}`);
}

function nextNumber(db) {
  const count = db.value('SELECT COUNT(*) AS n FROM invoice');
  return `INV-${String(count + 1).padStart(4, '0')}`;
}

/* --------------------------------------------------------------------- run */

const handler = commands[command];

if (!handler) {
  commands.help();
  process.exitCode = command === undefined ? 0 : 1;
} else {
  try {
    await handler();
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exitCode = 1;
  }
}
