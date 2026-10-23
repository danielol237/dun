// The HTTP layer.
//
// Deliberately thin: every endpoint is a thin wrapper over the same functions
// the CLI calls. There is no second implementation of the business rules, so
// the web UI cannot drift from the CLI — they are two doors into one room.
//
// The server owns one database handle and serialises writes through it. sql.js
// is in-process, so this is genuinely single-threaded; that is a feature at
// this size, because it removes every class of concurrent-write bug.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Db } from './db.mjs';
import { Ledger } from './ledger.mjs';
import { parseAmount, formatAmount } from './money.mjs';
import {
  createClient,
  createInvoice,
  getInvoice,
  recordPayment,
  voidInvoice,
  openInvoices,
  dayStart,
} from './domain.mjs';
import { tick, checkInvariants, onPaymentRecorded } from './scheduler.mjs';
import * as persistence from './persistence.mjs';
import { planInvoice, selectPolicy } from './policy.mjs';
import { TEMPLATES } from './templates.mjs';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const HEADERS = {
  'Content-Security-Policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
  ].join('; '),
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

const MAX_BODY = 128 * 1024;

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body too large'), { code: 'too_large' }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (text.length === 0) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(Object.assign(new Error('invalid json'), { code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const resolved = normalize(join(PUBLIC_DIR, relative));

  if (!resolved.startsWith(PUBLIC_DIR.endsWith(sep) ? PUBLIC_DIR : PUBLIC_DIR + sep)) {
    return json(res, 403, { error: 'forbidden' });
  }

  try {
    const file = await readFile(resolved);
    res.writeHead(200, {
      ...HEADERS,
      'Content-Type': MIME[extname(resolved)] ?? 'application/octet-stream',
      'Content-Length': file.length,
    });
    res.end(file);
  } catch {
    json(res, 404, { error: 'not_found' });
  }
}

/* --------------------------------------------------------------- view model */

/**
 * The shape the UI actually needs.
 *
 * Built server-side so the client has no arithmetic to do. A front-end that
 * computes outstanding balances is a second implementation of the ledger, and
 * the two will disagree.
 */
function invoiceRow(db, invoice, now) {
  const detail = getInvoice(db, invoice.id);
  const daysLate = Math.floor((dayStart(now) - detail.due_on) / 86400000);

  const { policy, plan } = planInvoice(db, detail, { now });
  const pending = plan.filter((entry) => !entry.skipped && entry.scheduledFor > now);

  const lastSent = db.row(
    `SELECT sent_at,
            COALESCE(rendered_template_key, template_key) AS template_key
       FROM reminder
      WHERE invoice_id = ? AND sent_at IS NOT NULL
      ORDER BY sent_at DESC LIMIT 1`,
    [invoice.id],
  );

  return {
    id: detail.id,
    number: detail.number,
    client: detail.client_name,
    clientId: detail.client_id,
    currency: detail.currency,
    amountMinor: detail.amount_minor,
    outstandingMinor: detail.outstandingMinor,
    allocatedMinor: detail.allocatedMinor,
    amount: formatAmount(detail.amount_minor, detail.currency),
    outstanding: formatAmount(detail.outstandingMinor, detail.currency),
    issuedOn: detail.issued_on,
    dueOn: detail.due_on,
    status: detail.status,
    daysLate,
    policy: policy ? `${policy.name} v${policy.version}` : null,
    nextStep: pending.length > 0
      ? {
          at: pending[0].scheduledFor,
          template: pending[0].templateKey,
          label: TEMPLATES[pending[0].templateKey]?.label ?? pending[0].templateKey,
          short: TEMPLATES[pending[0].templateKey]?.short ?? pending[0].templateKey,
          channel: pending[0].channel,
        }
      : null,
    lastSent: lastSent
      ? {
          at: lastSent.sent_at,
          template: lastSent.template_key,
          label: TEMPLATES[lastSent.template_key]?.label ?? lastSent.template_key,
          short: TEMPLATES[lastSent.template_key]?.short ?? lastSent.template_key,
        }
      : null,
  };
}

function buildState(db, { now = Date.now() } = {}) {
  const ledger = new Ledger(db);
  const invoices = openInvoices(db, { now });

  const rows = invoices.map((invoice) => invoiceRow(db, invoice, now));

  const totals = db.rows(
    `SELECT currency,
            SUM(amount_minor) AS invoiced,
            SUM(COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.invoice_id = i.id), 0)) AS collected
       FROM invoice i
      WHERE i.voided_at IS NULL
      GROUP BY currency`,
  );

  const overdue = rows.filter((row) => row.daysLate > 0);
  const dueSoon = rows.filter((row) => row.daysLate === 0);
  const upcoming = rows.filter((row) => row.daysLate < 0);

  const outbox = db.rows(
    `SELECT o.id, o.channel, o.recipient, o.body, o.state, o.created_at, o.attempts,
            i.number, i.currency
       FROM outbox_message o
       LEFT JOIN reminder r ON r.id = o.reminder_id
       LEFT JOIN invoice i ON i.id = r.invoice_id
      ORDER BY o.id DESC LIMIT 40`,
  );

  const clients = db.rows(`
    SELECT p.id, p.display_name,
           (SELECT value FROM party_handle h WHERE h.party_id = p.id AND h.channel = 'whatsapp' LIMIT 1) AS whatsapp,
           (SELECT value FROM party_handle h WHERE h.party_id = p.id AND h.channel = 'email' LIMIT 1) AS email
      FROM party p
     WHERE p.kind = 'client'
     ORDER BY p.display_name
  `);

  const invariants = checkInvariants(db);

  return {
    now,
    totals: totals.map((row) => ({
      currency: row.currency,
      invoiced: formatAmount(row.invoiced, row.currency),
      collected: formatAmount(row.collected, row.currency),
      outstanding: formatAmount(row.invoiced - row.collected, row.currency),
      invoicedMinor: row.invoiced,
      collectedMinor: row.collected,
      outstandingMinor: row.invoiced - row.collected,
    })),
    counts: {
      overdue: overdue.length,
      dueToday: dueSoon.length,
      upcoming: upcoming.length,
      clients: clients.length,
      queued: outbox.filter((message) => message.state === 'queued').length,
    },
    invoices: rows.sort((a, b) => a.dueOn - b.dueOn),
    outbox: outbox.map((message) => ({
      ...message,
      at: message.created_at,
    })),
    clients,
    health: invariants.ok ? 'balanced' : 'unbalanced',
  };
}

/* ------------------------------------------------------------------ routes */

async function api(db, req, res, pathname, url) {
  const now = Date.now();

  if (pathname === '/api/state' && req.method === 'GET') {
    return json(res, 200, buildState(db, { now }));
  }

  if (pathname === '/api/clients' && req.method === 'POST') {
    const body = await readBody(req);
    const handles = [];
    if (body.whatsapp) handles.push({ channel: 'whatsapp', value: body.whatsapp });
    if (body.email) handles.push({ channel: 'email', value: body.email });

    const id = createClient(db, { displayName: body.name, handles, now });
    await db.flush();
    return json(res, 201, { id });
  }

  if (pathname === '/api/invoices' && req.method === 'POST') {
    const body = await readBody(req);
    const currency = body.currency || 'NGN';
    const amountMinor = parseAmount(body.amount, currency);
    const issuedOn = body.issuedOn ? dayStart(body.issuedOn) : dayStart(now);
    const dueDays = Number(body.dueDays ?? 14);

    const count = db.value('SELECT COUNT(*) AS n FROM invoice');
    const number = body.number || `INV-${String(count + 1).padStart(4, '0')}`;

    const id = createInvoice(db, {
      number,
      clientId: Number(body.clientId),
      currency,
      amountMinor,
      issuedOn,
      dueOn: issuedOn + dueDays * 86400000,
      now,
    });

    await db.flush();
    return json(res, 201, { id, number });
  }

  const voidMatch = /^\/api\/invoices\/(\d+)\/void$/.exec(pathname);
  if (voidMatch && req.method === 'POST') {
    const body = await readBody(req);
    voidInvoice(db, Number(voidMatch[1]), { reason: body.reason ?? null, now });
    await db.flush();
    return json(res, 200, { ok: true });
  }

  if (pathname === '/api/payments' && req.method === 'POST') {
    const body = await readBody(req);
    const currency = body.currency || 'NGN';
    const amountMinor = parseAmount(body.amount, currency);
    const clientId = Number(body.clientId);

    // Explicit allocation only, exactly as the CLI does it. Oldest first is a
    // stated rule, not a guess: it is what a human would do.
    let remaining = amountMinor;
    const allocations = [];
    for (const row of openInvoices(db, { now })) {
      if (remaining <= 0) break;
      if (row.client_id !== clientId || row.currency !== currency) continue;
      const take = Math.min(remaining, row.outstanding_minor);
      allocations.push({ invoiceId: row.id, amountMinor: take });
      remaining -= take;
    }

    const id = recordPayment(db, {
      clientId, currency, amountMinor, receivedOn: dayStart(now),
      source: 'manual', rawDescriptor: body.descriptor ?? null, allocations, now,
    });

    onPaymentRecorded(db, { clientId, currency, now });
    await db.flush();

    return json(res, 201, {
      id,
      allocated: formatAmount(amountMinor - remaining, currency),
      unallocated: remaining > 0 ? formatAmount(remaining, currency) : null,
    });
  }

  if (pathname === '/api/tick' && req.method === 'POST') {
    const result = tick(db, { now });
    await db.flush();
    return json(res, 200, result);
  }

  if (pathname === '/api/check' && req.method === 'GET') {
    return json(res, 200, checkInvariants(db));
  }

  return json(res, 404, { error: 'not_found' });
}

export async function createApp({ dbPath = 'data/dun.db' } = {}) {
  const db = await Db.open(dbPath);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    try {
      if (pathname.startsWith('/api/')) {
        return await api(db, req, res, pathname, url);
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return json(res, 405, { error: 'method_not_allowed' });
      }

      return await serveStatic(res, pathname);
    } catch (err) {
      // Domain errors are the user's to fix, so they are returned as 400 with
      // the real message. Anything else is ours, and stays internal.
      const known = /unknown|invalid|cannot|exceeds|must|needs|positive|unsupported|too many/i.test(err.message ?? '');
      if (known) return json(res, 400, { error: err.message });

      console.error('[dun] unhandled', err);
      return json(res, 500, { error: 'internal_error' });
    }
  });

  return { server, db };
}

export async function start({ port = Number(process.env.PORT ?? 3000), host = '0.0.0.0', dbPath } = {}) {
  const path = dbPath ?? 'data/dun.db';

  // ── Restore before the database is opened ──
  //
  // Order matters. On a host with an ephemeral disk the local file is gone after
  // every restart, so opening first would create an empty ledger and then
  // cheerfully serve it. A configured backup that cannot be restored is a fatal
  // startup error on purpose: an empty ledger that looks real is worse than a
  // service that refuses to start.
  const backupConfig = persistence.configFromEnv();
  if (backupConfig.enabled) {
    const restored = await persistence.restore({ config: backupConfig, dbPath: path });
    if (restored.error) {
      throw new Error(`could not restore the ledger: ${restored.error}`);
    }
    if (!restored.restored) {
      console.log(`[backup] starting fresh — ${restored.reason}`);
    }
  } else {
    console.log(`[backup] off-box copy disabled — ${backupConfig.reason}`);
  }

  const { server, db } = await createApp({ dbPath: path });

  // Keep the off-box copy current. The export is a snapshot of the whole
  // database, so it must flush first — sql.js holds the data in memory and the
  // file on disk is only as fresh as the last write.
  const stopBackup = persistence.startAutoBackup({
    config: backupConfig,
    exportBytes: async () => {
      await db.flush();
      return Buffer.from(db.export());
    },
  });

  await new Promise((resolve) => server.listen(port, host, resolve));
  const address = server.address();

  return {
    server,
    db,
    port: typeof address === 'object' ? address.port : port,
    stopBackup,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { port } = await start({ dbPath: process.env.DUN_DB ?? 'data/dun.db' });
  console.log(`dun listening on http://localhost:${port}`);
}
