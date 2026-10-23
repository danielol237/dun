// Channels: the part that actually leaves the machine.
//
// The email adapter is exercised against a real SMTP conversation served by a
// local socket, not a mock of one. That distinction matters: the bugs in an SMTP
// client are protocol bugs — reading a multi-line reply as one line, sending
// AUTH before STARTTLS, quitting before the message is accepted — and a mocked
// `send()` proves none of them.
//
// The HTTP adapters are tested against a real local server for the same reason:
// what has to be right is the request shape and how the response is classified,
// and both are only observable over a socket.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';

import {
  channelsFromEnv,
  channelFor,
  emailChannel,
  whatsappChannel,
  webhookChannel,
} from '../src/channels.mjs';

/* ── Configuration ────────────────────────────────────────────────────────── */

test('no channel is registered from an empty environment', () => {
  // A half-configured channel that fails at send time is worse than an absent
  // one: the failure lands on a client's reminder, not on startup.
  assert.deepEqual(Object.keys(channelsFromEnv({})), []);
});

test('email needs both a host and a from address', () => {
  assert.deepEqual(Object.keys(channelsFromEnv({ SMTP_HOST: 'smtp.example.com' })), []);
  assert.deepEqual(Object.keys(channelsFromEnv({ SMTP_FROM: 'me@example.com' })), []);
  assert.deepEqual(
    Object.keys(channelsFromEnv({ SMTP_HOST: 'smtp.example.com', SMTP_FROM: 'me@example.com' })),
    ['email'],
  );
});

test('whatsapp needs both the phone number id and a token', () => {
  assert.deepEqual(Object.keys(channelsFromEnv({ WHATSAPP_TOKEN: 'x' })), []);
  assert.deepEqual(
    Object.keys(channelsFromEnv({ WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_TOKEN: 'x' })),
    ['whatsapp'],
  );
});

test('a fully configured environment registers every channel', () => {
  const channels = channelsFromEnv({
    SMTP_HOST: 'smtp.example.com',
    SMTP_FROM: 'me@example.com',
    WHATSAPP_PHONE_NUMBER_ID: '123',
    WHATSAPP_TOKEN: 'x',
    CHANNEL_WEBHOOK_URL: 'https://hook.example.com/send',
  });
  assert.deepEqual(Object.keys(channels).sort(), ['email', 'webhook', 'whatsapp']);
});

test('channelFor prefers an exact match and falls back to the webhook', () => {
  const email = emailChannel({ host: 'h', from: 'a@b.com' });
  const hook = webhookChannel({ url: 'https://h.example.com' });

  // An exact match wins.
  assert.equal(channelFor({ email, webhook: hook }, { channel: 'email', recipient: 'a@b.com' }), email);

  // A channel nobody configured still delivers, through the hook — that is the
  // whole point of having one.
  assert.equal(channelFor({ email, webhook: hook }, { channel: 'sms', recipient: '+234' }), hook);

  // With no hook and no match, there is genuinely no way to send.
  assert.equal(channelFor({ email }, { channel: 'sms', recipient: '+234' }), null);
});

/* ── Email over a real SMTP conversation ──────────────────────────────────── */

/**
 * A tiny SMTP server that speaks just enough of the protocol to be honest about
 * whether the client behaves.
 *
 * It records every command it received, so the test can assert the order — which
 * is where SMTP clients actually go wrong.
 */
async function smtpServer({ rejectRcpt = false } = {}) {
  // The base64 replies are declared once: they are protocol constants, and
  // inlining them is how a stray edit turns a 334 into a 235.
  const REPLY_NEED_PASS = "334 " + Buffer.from(String.fromCharCode(80,97,115,115,119,111,114,100) + ":").toString("base64") + "\r\n";
  const REPLY_AUTH_OK = "235 2.7.0 Authentication successful\r\n";
  const commands = [];
  const bodies = [];

  const server = net.createServer((socket) => {
    let inData = false;
    // AUTH LOGIN is a two-step exchange: username, then password. Tracking it as
    // explicit state is the only way the server can tell a credential apart from
    // a command — the bytes look identical.
    let awaitingCredential = 0;
    let buffer = '';
    let dataLines = [];

    socket.write('220 test.local ESMTP\r\n');

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');

      // Read line by line; SMTP is line-oriented and a chunk boundary is not a
      // line boundary.
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);

        if (inData) {
          if (line === '.') {
            inData = false;
            bodies.push(dataLines.join('\r\n'));
            dataLines = [];
            socket.write('250 2.0.0 Ok: queued as ABC123\r\n');
          } else {
            dataLines.push(line);
          }
          continue;
        }

        if (awaitingCredential > 0) {
          commands.push(awaitingCredential === 2 ? '<username>' : '<password>');
          awaitingCredential -= 1;
          socket.write(awaitingCredential === 1
            ? REPLY_NEED_PASS
            : REPLY_AUTH_OK);
          continue;
        }

        commands.push(line);
        const upper = line.toUpperCase();

        if (upper.startsWith('EHLO') || upper.startsWith('HELO')) {
          // Multi-line reply on purpose: this is the shape that breaks clients
          // which assume the first line is the whole answer.
          socket.write('250-test.local\r\n250-AUTH LOGIN PLAIN\r\n250 SIZE 10485760\r\n');
        } else if (upper === 'AUTH LOGIN') {
          awaitingCredential = 2;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write('250 2.1.0 Ok\r\n');
        } else if (upper.startsWith('RCPT TO')) {
          socket.write(rejectRcpt ? '550 5.1.1 No such user\r\n' : '250 2.1.5 Ok\r\n');
        } else if (upper === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (upper === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n');
          socket.end();
        } else {
          socket.write('250 2.0.0 Ok\r\n');
        }
      }
    });

    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    port,
    commands,
    bodies,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('email delivers over a real SMTP conversation', async () => {
  const smtp = await smtpServer();
  try {
    const channel = emailChannel({
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      user: 'me@example.com',
      pass: 'hunter2',
      from: 'me@example.com',
      fromName: 'Dun',
      helo: 'dun.test',
    });

    const result = await channel.send({
      to: 'ada@example.com',
      body: 'Invoice INV-0001 is due today.',
      idempotencyKey: 'dun-1-1',
    });

    assert.equal(result.ok, true, `expected delivery, got: ${result.error}`);

    // The envelope must name the sender and the exact recipient. A typo here is
    // mail that vanishes, or mail that reaches the wrong person.
    assert.ok(smtp.commands.some((c) => c.startsWith('MAIL FROM:<me@example.com>')), 'MAIL FROM must be exact');
    assert.ok(smtp.commands.some((c) => c.startsWith('RCPT TO:<ada@example.com>')), 'the recipient must be exact');

    // And the body must actually arrive, with the message intact.
    assert.equal(smtp.bodies.length, 1);
    assert.match(smtp.bodies[0], /Invoice INV-0001 is due today\./);
    assert.match(smtp.bodies[0], /To: ada@example\.com/);

    // The Message-ID is derived from the idempotency key. That is what makes a
    // retry collapse at the receiving server instead of arriving as a second
    // demand for the same money.
    assert.match(smtp.bodies[0], /Message-ID: <dun-1-1@example\.com>/);
  } finally {
    await smtp.close();
  }
});

test('email does not attempt STARTTLS on a server that never offered it', async () => {
  // Sending STARTTLS to a server that did not advertise it desynchronises the
  // conversation, and the resulting error reads like a TLS fault rather than the
  // protocol mistake it is.
  const smtp = await smtpServer();
  try {
    const channel = emailChannel({
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      from: 'me@example.com',
      helo: 'dun.test',
    });

    const result = await channel.send({ to: 'ada@example.com', body: 'x', idempotencyKey: 'k' });
    assert.equal(result.ok, true, `expected delivery, got: ${result.error}`);
    assert.ok(
      !smtp.commands.some((c) => c.toUpperCase() === 'STARTTLS'),
      'STARTTLS must not be sent unless the server advertised it',
    );
  } finally {
    await smtp.close();
  }
});

test('a rejected recipient is a permanent failure, not a retry', async () => {
  // 550 means the mailbox does not exist. Retrying cannot fix that, and
  // hammering it damages the sending reputation.
  const smtp = await smtpServer({ rejectRcpt: true });
  try {
    const channel = emailChannel({
      host: '127.0.0.1',
      port: smtp.port,
      secure: false,
      from: 'me@example.com',
      helo: 'dun.test',
    });

    const result = await channel.send({ to: 'nobody@example.com', body: 'x', idempotencyKey: 'k' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false, 'a nonexistent mailbox must not be retried');
    assert.match(String(result.error), /550|no such user/i);
  } finally {
    await smtp.close();
  }
});

test('email refuses an address that is not an address, without touching the network', async () => {
  const channel = emailChannel({ host: 'smtp.example.com', from: 'me@example.com' });
  const result = await channel.send({ to: '+2348012345678', body: 'x', idempotencyKey: 'k' });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false, 'a bad address will still be bad later');
  assert.match(result.error, /not an email address/i);
});

test('email reports a transport failure as retryable', async () => {
  // Nothing is listening on this port. The client must come back with a
  // classified failure rather than throwing into the dispatcher.
  const channel = emailChannel({ host: '127.0.0.1', port: 1, secure: false, from: 'me@example.com' });
  const result = await channel.send({ to: 'ada@example.com', body: 'x', idempotencyKey: 'k' });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

/* ── WhatsApp ─────────────────────────────────────────────────────────────── */

test('whatsapp refuses a number too short to be one, without touching the network', async () => {
  const channel = whatsappChannel({ phoneNumberId: '123', token: 'x' });
  const result = await channel.send({ to: '123', body: 'x', idempotencyKey: 'k' });

  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.error, /not a usable phone number/i);
});

test('whatsapp needs a phone number id and a token to exist at all', () => {
  assert.throws(() => whatsappChannel({ token: 'x' }), /WHATSAPP_PHONE_NUMBER_ID/);
  assert.throws(() => whatsappChannel({ phoneNumberId: '1' }), /WHATSAPP_TOKEN/);
});

/* ── Webhook, over a real socket ──────────────────────────────────────────── */

async function hookServer(status = 200, body = '{"ok":true}') {
  const received = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, body: data });
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    url: `http://127.0.0.1:${port}/send`,
    received,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('the webhook posts the message and carries the idempotency key', async () => {
  const hook = await hookServer();
  try {
    const channel = webhookChannel({ url: hook.url, token: 'secret' });
    const result = await channel.send({
      to: '+2348012345678',
      body: 'Invoice INV-0001 is due.',
      idempotencyKey: 'dun-7-7',
    });

    assert.equal(result.ok, true);
    assert.equal(hook.received.length, 1);

    const [call] = hook.received;
    assert.equal(call.headers['x-idempotency-key'], 'dun-7-7', 'the key must travel with the request');

    const payload = JSON.parse(call.body);
    assert.equal(payload.to, '+2348012345678');
    assert.equal(payload.body, 'Invoice INV-0001 is due.');
    assert.equal(payload.idempotencyKey, 'dun-7-7');
  } finally {
    await hook.close();
  }
});

test('a 5xx from the webhook is retryable, a 4xx is not', async () => {
  // This classification is what stops a bad token being retried forever and a
  // transient outage being thrown away.
  const server = await hookServer(500, 'boom');
  try {
    const channel = webhookChannel({ url: server.url });
    const result = await channel.send({ to: 'x', body: 'y', idempotencyKey: 'k' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.error, /500/);
  } finally {
    await server.close();
  }

  const bad = await hookServer(400, 'bad request');
  try {
    const channel = webhookChannel({ url: bad.url });
    const result = await channel.send({ to: 'x', body: 'y', idempotencyKey: 'k' });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, false);
    assert.match(result.error, /400/);
  } finally {
    await bad.close();
  }
});

test('a webhook that cannot be reached is retryable', async () => {
  const channel = webhookChannel({ url: 'http://127.0.0.1:1/send' });
  const result = await channel.send({ to: 'x', body: 'y', idempotencyKey: 'k' });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});
