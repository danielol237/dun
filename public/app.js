// Dun — the client.
//
// No framework. The whole state comes from one endpoint, already formatted and
// already sorted, because the server owns every calculation. This file decides
// what to draw, never what a number means.

const $ = (id) => document.getElementById(id);

const state = {
  data: null,
  filter: 'all',
};

/* ---------------------------------------------------------------------- api */

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error ?? 'request failed');
  }

  return data;
}

/* ---------------------------------------------------------------------- dom */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (value !== undefined && value !== null && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function notice(message, tone = 'info') {
  $('notice').replaceChildren(
    message ? el('p', { class: `notice${tone === 'info' ? '' : ` is-${tone}`}`, text: message }) : null,
  );
}

const shortDate = (ts) =>
  new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });

const longDate = (ts) =>
  new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

function relative(ts) {
  const minutes = Math.round((ts - Date.now()) / 60000);
  if (minutes < 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

/* --------------------------------------------------------------------- rail */

function renderRail(data) {
  const totals = $('totals');
  totals.replaceChildren(
    ...data.totals.map((total) =>
      el('div', { class: 'total' }, [
        el('span', { class: 'total-label', text: 'Outstanding' }),
        el('span', {
          class: `total-value${data.counts.overdue > 0 ? ' is-late' : ''}`,
          text: total.outstanding,
        }),
        el('span', { class: 'total-meta', text: `${total.collected} collected of ${total.invoiced}` }),
      ]),
    ),
  );

  if (data.totals.length === 0) {
    totals.replaceChildren(el('p', { class: 'total-meta', text: 'nothing invoiced yet' }));
  }

  $('counts').replaceChildren(
    countRow('late', 'Overdue', data.counts.overdue),
    countRow('today', 'Due today', data.counts.dueToday),
    countRow('upcoming', 'Upcoming', data.counts.upcoming),
    countRow('queued', 'Queued', data.counts.queued),
  );

  const health = $('health');
  health.textContent = data.health === 'balanced' ? 'ledger balanced' : 'ledger unbalanced';
  health.className = `health${data.health === 'balanced' ? '' : ' is-bad'}`;

  $('clock').textContent = new Date(data.now).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

function countRow(kind, label, value) {
  return el('div', { class: 'count-row' }, [
    el('span', { class: 'count-key' }, [
      el('span', { class: `count-dot ${kind}` }),
      el('span', { text: label }),
    ]),
    el('span', { class: 'count-val', text: String(value) }),
  ]);
}

/* -------------------------------------------------------------------- board */

function group(title, rows, { late = false } = {}) {
  if (rows.length === 0) return null;

  const total = rows.reduce((sum, row) => sum + row.outstandingMinor, 0);
  const currency = rows[0].currency;

  return el('section', { class: 'group' }, [
    el('header', { class: 'group-head' }, [
      el('h2', { class: `group-title${late ? ' is-late' : ''}`, text: title }),
      el('span', { class: 'group-count', text: `${rows.length}` }),
      el('span', {
        class: 'group-sum',
        text: formatMoney(total, currency),
      }),
    ]),
    ...rows.map(invoiceRow),
  ]);
}

/**
 * Group subtotal formatting.
 *
 * The server formats every individual amount; this only exists for the sum of a
 * group, which the server does not send. It deliberately mirrors the server's
 * format so a subtotal and its rows never disagree.
 */
function formatMoney(minor, currency) {
  const symbols = { NGN: '₦', USD: '$', EUR: '€', GBP: '£', GHS: '₵', KES: 'KSh' };
  const prefix = symbols[currency] ?? `${currency} `;
  const places = 2;
  const whole = Math.floor(Math.abs(minor) / 10 ** places).toLocaleString('en-NG');
  const fraction = String(Math.abs(minor) % 10 ** places).padStart(places, '0');
  return `${prefix}${whole}.${fraction}`;
}

function invoiceRow(invoice) {
  const late = invoice.daysLate > 0;
  const today = invoice.daysLate === 0;

  // "7d" under an AGE column that otherwise means days-late reads as seven days
  // late. Future invoices say "in 7d" so the direction is never ambiguous.
  const ageText = late
    ? `${invoice.daysLate}d late`
    : today
      ? 'due today'
      : `in ${-invoice.daysLate}d`;

  return el(
    'button',
    {
      class: `row${late ? ' is-late' : ''}`,
      type: 'button',
      onclick: () => openInvoice(invoice),
      'aria-label': `${invoice.number}, ${invoice.client}, ${invoice.outstanding}`,
    },
    [
      el('span', { class: 'row-num', text: invoice.number }),
      el('span', { class: 'row-client', text: invoice.client }),
      el('span', { class: 'row-policy', text: invoice.policy ?? '—' }),
      el('span', { class: 'row-amount', text: invoice.outstanding }),
      el('span', {
        class: `row-days ${late ? 'is-late' : today ? 'is-today' : 'is-upcoming'}`,
        text: ageText,
      }),
      el('span', {
        class: 'row-next',
        text: invoice.nextStep
          ? `${shortDate(invoice.nextStep.at)} · ${invoice.nextStep.short}`
          : invoice.lastSent
            ? `sent ${shortDate(invoice.lastSent.at)}`
            : '—',
      }),
    ],
  );
}

function renderBoard(data) {
  const rows = data.invoices.filter((invoice) => {
    if (state.filter === 'late') return invoice.daysLate > 0;
    if (state.filter === 'soon') return invoice.daysLate <= 0 && invoice.daysLate > -8;
    return true;
  });

  const late = rows.filter((invoice) => invoice.daysLate > 0);
  const today = rows.filter((invoice) => invoice.daysLate === 0);
  const upcoming = rows.filter((invoice) => invoice.daysLate < 0);

  $('groups').replaceChildren(
    ...[
      group('Overdue', late, { late: true }),
      group('Due today', today),
      group('Upcoming', upcoming),
    ].filter(Boolean),
  );

  $('empty').hidden = rows.length > 0;
  $('col-head').hidden = rows.length === 0;

  const totalOut = data.totals[0]?.outstanding ?? '—';
  $('board-sub').textContent = rows.length === 0
    ? 'no invoices match this filter'
    : `${rows.length} invoice${rows.length === 1 ? '' : 's'} · ${totalOut} outstanding`;

  renderFoot(data);
}

/**
 * The desk footer: what the book is worth, how bad the worst debt is, and
 * whether the ledger agrees. Read once before closing the laptop.
 */
function renderFoot(data) {
  const foot = $('board-foot');

  if (!data.totals.length) {
    foot.replaceChildren();
    return;
  }

  const worst = data.invoices.reduce(
    (max, invoice) => Math.max(max, invoice.daysLate),
    0,
  );

  const oldest = data.invoices
    .filter((invoice) => invoice.daysLate > 0)
    .sort((a, b) => b.daysLate - a.daysLate)[0];

  foot.replaceChildren(
    el('span', {}, [
      el('span', { class: 'foot-key', text: 'Book' }),
      el('span', { class: 'foot-val', text: data.totals[0].outstanding }),
    ]),
    el('span', {}, [
      el('span', { class: 'foot-key', text: 'Open' }),
      el('span', { class: 'foot-val', text: String(data.invoices.length) }),
    ]),
    worst > 0
      ? el('span', {}, [
          el('span', { class: 'foot-key', text: 'Worst' }),
          el('span', {
            class: 'foot-val is-late',
            text: `${worst}d — ${oldest.number}`,
          }),
        ])
      : el('span', {}, [
          el('span', { class: 'foot-key', text: 'Worst' }),
          el('span', { class: 'foot-val', text: 'nothing late' }),
        ]),
    // Ledger health already lives in the rail. Repeating it here would be the
    // same fact in two places, which is how a screen teaches people to stop
    // reading either of them.
  );
}

/* --------------------------------------------------------------------- feed */

function renderFeed(data) {
  const feed = $('feed');
  $('feed-count').textContent = String(data.outbox.length);

  if (data.outbox.length === 0) {
    feed.replaceChildren(
      el('p', { class: 'feed-empty', text: 'Nothing queued. Run the chase.' }),
    );
    return;
  }

  feed.replaceChildren(
    ...data.outbox.map((message) =>
      el('article', { class: 'feed-item' }, [
        el('div', { class: 'feed-meta' }, [
          el('span', { class: `feed-channel${message.state === 'queued' ? ' is-queued' : ''}`, text: message.channel }),
          el('span', { text: message.number ?? '' }),
          el('span', { text: shortDate(message.at) }),
        ]),
        el('p', { class: 'feed-body', text: message.body }),
      ]),
    ),
  );
}

/* -------------------------------------------------------------------- modal */

const modal = $('modal');
let modalSubmitHandler = null;

function openModal({ title, body, submitLabel = 'Save', onSubmit }) {
  $('modal-title').textContent = title;
  $('modal-body').replaceChildren(...body);
  $('modal-submit').textContent = submitLabel;
  modalSubmitHandler = onSubmit;
  modal.showModal();
}

$('modal-form').addEventListener('submit', async (event) => {
  if (event.submitter?.value !== 'ok') {
    modalSubmitHandler = null;
    return;
  }

  event.preventDefault();

  const button = $('modal-submit');
  button.disabled = true;

  try {
    const ok = await modalSubmitHandler?.();
    if (ok !== false) {
      modal.close();
      modalSubmitHandler = null;
      await refresh();
    }
  } catch (err) {
    notice(err.message, 'bad');
  } finally {
    button.disabled = false;
  }
});

/**
 * A labelled field.
 *
 * The label is bound with `for`, and the hint with `aria-describedby`, rather
 * than wrapping both in a <label>. Wrapping folds the hint into the field's
 * accessible name, so a screen reader announces "WhatsApp Local or
 * international — both normalise to the same number" as the name of the box.
 */
function field(label, input, hint) {
  const id = input.id;
  if (!id) throw new Error(`field "${label}" needs an id`); // a label with no
  // `for` is decoration, and the id is what makes it a label.

  const hintId = hint ? `${id}-hint` : null;
  if (hintId) input.setAttribute('aria-describedby', hintId);

  return el('div', { class: 'field' }, [
    el('label', { class: 'field-label', for: id, text: label }),
    input,
    hint ? el('span', { class: 'field-hint', id: hintId, text: hint }) : null,
  ]);
}

/* ------------------------------------------------------------------ actions */

$('new-client').addEventListener('click', () => {
  const name = el('input', { class: 'field-input', id: 'c-name', placeholder: 'Ada Obi', autocomplete: 'off' });
  const whatsapp = el('input', { class: 'field-input', id: 'c-wa', placeholder: '08031234567', autocomplete: 'off' });
  const email = el('input', { class: 'field-input', id: 'c-email', placeholder: 'ada@example.com', autocomplete: 'off' });

  openModal({
    title: 'New client',
    body: [
      field('Name', name),
      field('WhatsApp', whatsapp, 'Local or international — both normalise to the same number.'),
      field('Email', email, 'Optional. Used only if WhatsApp has no address.'),
    ],
    submitLabel: 'Add client',
    onSubmit: async () => {
      await api('/api/clients', {
        method: 'POST',
        body: { name: name.value, whatsapp: whatsapp.value, email: email.value },
      });
    },
  });

  name.focus();
});

$('new-invoice').addEventListener('click', () => {
  const clients = state.data?.clients ?? [];

  if (clients.length === 0) {
    notice('Add a client first.', 'bad');
    return;
  }

  const client = el(
    'select',
    { class: 'field-select', id: 'i-client' },
    clients.map((entry) =>
      el('option', { value: String(entry.id), text: entry.display_name }),
    ),
  );

  const amount = el('input', { class: 'field-input', id: 'i-amount', placeholder: '450000', inputmode: 'decimal' });
  const days = el('input', { class: 'field-input', id: 'i-days', value: '14', inputmode: 'numeric' });
  const issued = el('input', { class: 'field-input', id: 'i-issued', type: 'date' });

  openModal({
    title: 'New invoice',
    body: [
      field('Client', client),
      field('Amount', amount, 'Naira. Decimals allowed — it is stored as integer kobo.'),
      field('Payment terms', days, 'Days from the issue date.'),
      field('Issued', issued, 'Leave blank for today.'),
    ],
    submitLabel: 'Raise invoice',
    onSubmit: async () => {
      await api('/api/invoices', {
        method: 'POST',
        body: {
          clientId: Number(client.value),
          amount: amount.value,
          dueDays: Number(days.value),
          issuedOn: issued.value || undefined,
        },
      });
    },
  });

  amount.focus();
});

$('run-tick').addEventListener('click', async () => {
  const button = $('run-tick');
  button.disabled = true;
  button.textContent = 'Running…';

  try {
    const result = await api('/api/tick', { method: 'POST' });
    await refresh();

    const parts = [];
    if (result.queued > 0) parts.push(`${result.queued} queued`);
    if (result.superseded > 0) parts.push(`${result.superseded} superseded`);
    if (result.cancelled > 0) parts.push(`${result.cancelled} cancelled`);

    notice(parts.length > 0 ? parts.join(' · ') : 'nothing due — no messages sent', 'good');
  } catch (err) {
    notice(err.message, 'bad');
  } finally {
    button.disabled = false;
    button.textContent = 'Run the chase';
  }
});

for (const seg of document.querySelectorAll('.seg')) {
  seg.addEventListener('click', () => {
    state.filter = seg.dataset.filter;
    for (const other of document.querySelectorAll('.seg')) {
      other.classList.toggle('is-on', other === seg);
    }
    if (state.data) renderBoard(state.data);
  });
}

/* ------------------------------------------------------------------- detail */

function openInvoice(invoice) {
  const detail = el('div', {}, [
    el('div', { class: 'detail-grid' }, [
      el('span', { class: 'detail-key', text: 'Client' }),
      el('span', { class: 'detail-val', text: invoice.client }),
      el('span', { class: 'detail-key', text: 'Invoiced' }),
      el('span', { class: 'detail-val', text: invoice.amount }),
      el('span', { class: 'detail-key', text: 'Outstanding' }),
      el('span', { class: 'detail-val', text: invoice.outstanding }),
      el('span', { class: 'detail-key', text: 'Issued' }),
      el('span', { class: 'detail-val', text: longDate(invoice.issuedOn) }),
      el('span', { class: 'detail-key', text: 'Due' }),
      el('span', { class: 'detail-val', text: longDate(invoice.dueOn) }),
      el('span', { class: 'detail-key', text: 'Policy' }),
      el('span', { class: 'detail-val', text: invoice.policy ?? 'none' }),
    ]),
  ]);

  if (invoice.lastSent) {
    detail.append(
      el('div', { class: 'detail-section' }, [
        el('h3', { text: 'Last message' }),
        el('p', {
          class: 'field-hint',
          text: `${invoice.lastSent.label} · ${longDate(invoice.lastSent.at)}`,
        }),
      ]),
    );
  }

  if (invoice.nextStep) {
    detail.append(
      el('div', { class: 'detail-section' }, [
        el('h3', { text: 'Next' }),
        el('p', {
          class: 'field-hint',
          text: `${invoice.nextStep.label} on ${longDate(invoice.nextStep.at)} · ${relative(invoice.nextStep.at)} via ${invoice.nextStep.channel}`,
        }),
      ]),
    );
  }

  const payAmount = el('input', {
    class: 'field-input',
    id: 'p-amount',
    placeholder: invoice.outstanding.replace(/[^\d.]/g, ''),
    inputmode: 'decimal',
  });

  detail.append(
    el('div', { class: 'detail-section' }, [
      el('h3', { text: 'Record a payment' }),
      field('Amount received', payAmount, 'Allocated to this invoice first, oldest first across the rest.'),
    ]),
  );

  openModal({
    title: invoice.number,
    body: [detail],
    submitLabel: 'Record payment',
    onSubmit: async () => {
      const amount = payAmount.value.trim();
      if (amount.length === 0) {
        notice('Enter an amount to record.', 'bad');
        return false;
      }

      const result = await api('/api/payments', {
        method: 'POST',
        body: { clientId: invoice.clientId, currency: invoice.currency, amount: amount },
      });

      notice(
        result.unallocated
          ? `${result.allocated} allocated · ${result.unallocated} left as credit`
          : `${result.allocated} allocated`,
        'good',
      );

      return true;
    },
  });
}

/* ------------------------------------------------------------------ refresh */

async function refresh() {
  try {
    state.data = await api('/api/state');
    renderRail(state.data);
    renderBoard(state.data);
    renderFeed(state.data);
  } catch (err) {
    notice(`Could not load: ${err.message}`, 'bad');
  }
}

await refresh();

// The clock in the rail is the only thing that ticks on its own; everything
// else changes because something happened.
setInterval(() => {
  if (state.data) {
    $('clock').textContent = new Date().toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }
}, 30_000);
