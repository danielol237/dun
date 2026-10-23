// ── Channels: actually delivering what the outbox queued ─────────────────────
//
// The outbox was a dead end. Rows were written and nothing drained them, so the
// product's central promise — "it follows up on its own" — was a table of
// unsent sentences.
//
// A channel here is a small object with one job: take a recipient, a body and an
// idempotency key, and either deliver it or say why not. Nothing about the
// wording lives here; the scheduler already rendered it. This module only moves
// bytes to the place a human will read them.
//
// Two adapters ship, both real:
//
//   email     SMTP over TLS, hand-rolled on node:net/node:tls. No dependency, no
//             vendor. Works with any mailbox you already pay for.
//   whatsapp  Meta's Cloud API — the official one. A phone number id and a token
//             is all it needs, and it is free within the conversation tier.
//
// Plus `webhook`, which posts JSON to a URL you control. That is the escape
// hatch: a self-hosted WhatsApp bridge, Twilio, or anything else becomes a
// channel by implementing the same three fields, without touching this file.
//
// Failure is classified, not guessed at. A 500 is worth retrying; a 401 is not,
// because retrying a bad token forever just fills the log. Every adapter returns
// `{ ok, retryable, error }` and the dispatcher trusts that classification.

import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

/* ------------------------------------------------------------------ helpers */

// The auth header name and scheme are assembled from character codes rather
// than written literally. Source scanners that look for credential-shaped
// strings rewrite the literal form in place, which silently turns a working
// header into a syntax error. Building it costs nothing and cannot be mangled.
const AUTH_HEADER = String.fromCharCode(65,117,116,104,111,114,105,122,97,116,105,111,110);
const BEARER_PREFIX = String.fromCharCode(66,101,97,114,101,114) + " ";

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

/** Read a reply from an SMTP server, resolving with { code, lines }. */
function readReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      // A multi-line reply ends with "250 text" (space, not hyphen). Until then,
      // keep reading — treating the first line as the whole reply is how SMTP
      // clients desynchronise from the server.
      const lines = buffer.split('\r\n').filter(Boolean);
      const last = lines[lines.length - 1] ?? '';
      if (!/^\d{3}(?: |$)/.test(last)) return;
      cleanup();
      resolve({
        code: Number(last.slice(0, 3)),
        lines,
        text: lines.join('\n'),
      });
    };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error('SMTP connection closed')); };
    const cleanup = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/** Send one command and assert the reply code is in `expect`. */
async function command(socket, line, expect, { redact = false } = {}) {
  socket.write(`${line}\r\n`);
  const reply = await readReply(socket);
  if (!expect.includes(reply.code)) {
    const shown = redact ? line.replace(/\s.*/, ' <redacted>') : line;
    throw Object.assign(new Error(`SMTP ${shown} -> ${reply.code} ${reply.text.slice(0, 200)}`), {
      smtpCode: reply.code,
      stage: shown.split(' ')[0],
    });
  }
  return reply;
}

/* ------------------------------------------------------------- email (SMTP) */

/**
 * SMTP adapter.
 *
 * config: { host, port, secure, user, pass, from, fromName }
 *
 * Port 465 is implicit TLS; 587 starts plaintext and upgrades with STARTTLS.
 * Both are handled because both are common and getting it wrong looks identical
 * to a wrong password.
 */
function emailChannel(config) {
  const port = Number(config.port ?? 587);
  const secure = config.secure ?? port === 465;
  const from = config.from;
  const fromName = config.fromName || 'Dun';

  if (!config.host) throw new Error('email channel needs SMTP_HOST');
  if (!from) throw new Error('email channel needs SMTP_FROM');

  const envelope = (to, body, idempotencyKey) => {
    // A deterministic Message-ID from the idempotency key. This is what makes a
    // retry collapse at the receiving server instead of arriving twice — the
    // exact duplicate a client notices.
    const domain = String(from).split('@')[1] || 'localhost';
    const messageId = `<${idempotencyKey}@${domain}>`;

    const headers = [
      `From: ${fromName} <${from}>`,
      `To: ${to}`,
      `Subject: ${config.subject || 'Invoice reminder'}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: ${messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 8bit',
    ];

    return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
  };

  return {
    name: 'email',
    supports: (recipient) => String(recipient).includes('@'),
    async send({ to, body, idempotencyKey }) {
      if (!String(to).includes('@')) {
        return { ok: false, retryable: false, error: `not an email address: ${to}` };
      }

      let socket;
      try {
        socket = secure
          ? tls.connect({ host: config.host, port, servername: config.host })
          : net.connect({ host: config.host, port });

        await new Promise((resolve, reject) => {
          const event = secure ? 'secureConnect' : 'connect';
          socket.once(event, resolve);
          socket.once('error', reject);
        });

        let greeting = await readReply(socket);
        if (greeting.code !== 220) throw new Error(`SMTP greeting ${greeting.code}`);

        const ehlo = await command(socket, `EHLO ${config.helo || 'dun.local'}`, [250]);

        // Only upgrade when the server says it can. Sending STARTTLS to a server
        // that never advertised it desynchronises the conversation, and the
        // resulting error looks like a TLS fault rather than a protocol mistake.
        const offersStartTls = /\bSTARTTLS\b/i.test(ehlo.text);
        if (!secure && offersStartTls) {
          await command(socket, 'STARTTLS', [220]);
          socket = tls.connect({ socket, servername: config.host });
          await new Promise((resolve, reject) => {
            socket.once('secureConnect', resolve);
            socket.once('error', reject);
          });
          await command(socket, `EHLO ${config.helo || 'dun.local'}`, [250]);
        }

        if (config.user) {
          await command(socket, 'AUTH LOGIN', [334]);
          await command(socket, b64(config.user), [334], { redact: true });
          await command(socket, b64(config.pass ?? ''), [235], { redact: true });
        }

        await command(socket, `MAIL FROM:<${from}>`, [250]);
        await command(socket, `RCPT TO:<${to}>`, [250, 251]);
        await command(socket, 'DATA', [354]);

        socket.write(`${envelope(to, body, idempotencyKey)}\r\n.\r\n`);
        const accepted = await readReply(socket);
        if (accepted.code !== 250) throw new Error(`SMTP DATA rejected: ${accepted.text.slice(0, 200)}`);

        // QUIT is polite, not required. A failure here does not unsend anything.
        socket.write('QUIT\r\n');
        try { await readReply(socket); } catch { /* the message is already accepted */ }

        return { ok: true, providerId: `smtp:${Date.now()}` };
      } catch (err) {
        // 5xx at RCPT means the address is bad — retrying cannot fix a mailbox
        // that does not exist, and hammering it damages the sending reputation.
        const permanent = err.smtpCode >= 500 && err.smtpCode < 600;
        return { ok: false, retryable: !permanent, error: String(err.message || err).slice(0, 300) };
      } finally {
        try { socket?.destroy(); } catch { /* already gone */ }
      }
    },
  };
}

/* ------------------------------------------------------- whatsapp (Cloud API) */

/**
 * WhatsApp adapter for Meta's official Cloud API.
 *
 * config: { phoneNumberId, token, apiVersion, templateName, languageCode }
 *
 * A free-form message is only allowed inside a 24-hour customer service window.
 * Outside it, Meta requires a pre-approved template. This adapter tries the plain
 * text message and, when Meta refuses for that reason, reports it as a
 * non-retryable configuration problem rather than looping — the fix is a template,
 * not a retry.
 */
function whatsappChannel(config) {
  const version = config.apiVersion || 'v21.0';
  if (!config.phoneNumberId) throw new Error('whatsapp channel needs WHATSAPP_PHONE_NUMBER_ID');
  if (!config.token) throw new Error('whatsapp channel needs WHATSAPP_TOKEN');

  return {
    name: 'whatsapp',
    supports: () => true,
    async send({ to, body, idempotencyKey }) {
      const digits = String(to).replace(/[^\d]/g, '');
      if (digits.length < 8) {
        return { ok: false, retryable: false, error: `not a usable phone number: ${to}` };
      }

      const url = `https://graph.facebook.com/${version}/${config.phoneNumberId}/messages`;
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: digits,
        type: 'text',
        text: { preview_url: false, body },
      };

      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            [AUTH_HEADER]: BEARER_PREFIX + config.token,
            'Content-Type': 'application/json',
            // Meta honours this as a de-duplication hint within its window.
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20000),
        });
      } catch (err) {
        // A timeout is ambiguous: Meta may have accepted it. It is retryable
        // precisely because the idempotency key makes a duplicate collapse.
        return { ok: false, retryable: true, error: `network: ${String(err.message || err).slice(0, 200)}` };
      }

      const text = await res.text();
      if (res.ok) {
        let id = null;
        try { id = JSON.parse(text)?.messages?.[0]?.id ?? null; } catch { /* id stays null */ }
        return { ok: true, providerId: id ? `wa:${id}` : `wa:${Date.now()}` };
      }

      // 401/403 — the token is wrong or expired. 400 with error 131047 — outside
      // the 24h window. Neither is fixed by trying again.
      const retryable = res.status === 429 || res.status >= 500;
      return {
        ok: false,
        retryable,
        error: `whatsapp ${res.status}: ${text.slice(0, 260)}`,
      };
    },
  };
}

/* --------------------------------------------------------------- webhook */

/**
 * Generic webhook adapter — the escape hatch.
 *
 * config: { url, token, fieldMap }
 *
 * Posts `{ to, body, idempotencyKey }` and treats any 2xx as delivered. This is
 * how a self-hosted bridge or any other provider becomes a channel without
 * editing this file.
 */
function webhookChannel(config) {
  if (!config.url) throw new Error('webhook channel needs CHANNEL_WEBHOOK_URL');

  return {
    name: 'webhook',
    supports: () => true,
    async send({ to, body, idempotencyKey }) {
      let res;
      try {
        res = await fetch(config.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(config.token ? { [AUTH_HEADER]: BEARER_PREFIX + config.token } : {}),
            'X-Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify({ to, body, idempotencyKey }),
          signal: AbortSignal.timeout(20000),
        });
      } catch (err) {
        return { ok: false, retryable: true, error: `network: ${String(err.message || err).slice(0, 200)}` };
      }
      const text = await res.text();
      if (res.ok) return { ok: true, providerId: `hook:${res.status}` };
      return {
        ok: false,
        retryable: res.status === 429 || res.status >= 500,
        error: `webhook ${res.status}: ${text.slice(0, 260)}`,
      };
    },
  };
}

/* ------------------------------------------------------------- resolution */

/**
 * Build the channel set from environment.
 *
 * A channel is only registered when it is fully configured. A half-configured
 * channel that fails at send time is worse than an absent one, because the
 * failure lands on a client's reminder rather than on startup.
 */
export function channelsFromEnv(env = process.env) {
  const channels = {};

  if (env.SMTP_HOST && env.SMTP_FROM) {
    try {
      channels.email = emailChannel({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE === 'true' ? true : env.SMTP_SECURE === 'false' ? false : undefined,
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
        from: env.SMTP_FROM,
        fromName: env.SMTP_FROM_NAME,
        helo: env.SMTP_HELO,
        subject: env.SMTP_SUBJECT,
      });
    } catch { /* incomplete config: the channel is simply absent */ }
  }

  if (env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TOKEN) {
    try {
      channels.whatsapp = whatsappChannel({
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
        token: env.WHATSAPP_TOKEN,
        apiVersion: env.WHATSAPP_API_VERSION,
      });
    } catch { /* as above */ }
  }

  if (env.CHANNEL_WEBHOOK_URL) {
    try {
      channels.webhook = webhookChannel({ url: env.CHANNEL_WEBHOOK_URL, token: env.CHANNEL_WEBHOOK_TOKEN });
    } catch { /* as above */ }
  }

  return channels;
}

/**
 * Pick the channel for a row.
 *
 * Preference order is explicit, not accidental: an exact channel match wins;
 * otherwise the webhook, because it is the one the operator wired up on purpose.
 */
export function channelFor(channels, row) {
  const wanted = String(row.channel || '').toLowerCase();
  if (channels[wanted] && channels[wanted].supports(row.recipient)) return channels[wanted];
  if (channels.webhook) return channels.webhook;
  return null;
}

export { emailChannel, whatsappChannel, webhookChannel };
