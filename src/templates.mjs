// Templates.
//
// Messages are data. Each template declares the range of days-late it is
// honest for, and that range is load-bearing: a step scheduled for the due date
// can be claimed a week later if the scheduler was down, and sending "this is
// due today" to a client who is six days overdue is worse than sending nothing.
//
// So the claim path picks the template whose range contains the invoice's
// *actual* state. A message is never factually wrong about the date.

/** Default template set. */
export const TEMPLATES = {
  heads_up: {
    label: 'Heads up before due',
    short: 'heads up',
    minDaysLate: -999,
    maxDaysLate: -1,
    body: 'Hi {{client}}, quick heads-up that invoice {{number}} for {{amount}} is due {{due_date}}. No rush — just so it is on your radar.',
  },
  due_today: {
    label: 'Due today',
    short: 'due today',
    minDaysLate: 0,
    maxDaysLate: 0,
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} is due today. Let me know if you need the details resent.',
  },
  late_gentle: {
    label: 'Recently late',
    short: 'nudge',
    minDaysLate: 1,
    maxDaysLate: 13,
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} was due {{days_late}} days ago. Have you had a chance to look at it?',
  },
  late_firm: {
    label: 'Two weeks late',
    short: 'firm chase',
    minDaysLate: 14,
    maxDaysLate: 29,
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} is now {{days_late}} days overdue. Can you confirm when it will be settled?',
  },
  late_escalate: {
    label: 'A month late',
    short: 'escalate',
    minDaysLate: 30,
    maxDaysLate: 99999,
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} is {{days_late}} days overdue. I need a payment date on this one — please confirm today.',
  },
  late_flag: {
    label: 'Flagged for the owner',
    short: 'flag owner',
    minDaysLate: 0,
    maxDaysLate: 99999,
    body: 'Invoice {{number}} for {{client}} ({{amount}}) is {{days_late}} days overdue. No automatic follow-up will be sent from here.',
  },
};

/**
 * The client-facing template that honestly describes an invoice right now.
 *
 * @param {number} daysLate
 * @returns {string} a template key, never `late_flag`
 */
export function honestTemplateKey(daysLate, templates = TEMPLATES) {
  const clientFacing = Object.entries(templates).filter(([key]) => key !== 'late_flag');

  for (const [key, template] of clientFacing) {
    if (daysLate >= template.minDaysLate && daysLate <= template.maxDaysLate) {
      return key;
    }
  }

  return 'late_escalate';
}

/**
 * Render a template.
 *
 * Unknown variables are left in place rather than replaced with an empty
 * string, so a broken template is visible in the sent message instead of
 * producing a sentence with a hole in it.
 */
export function render(templateKey, variables, templates = TEMPLATES) {
  const template = templates[templateKey];
  if (!template) throw new Error(`unknown template: ${templateKey}`);

  return template.body.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    const value = variables[name];
    return value === undefined || value === null ? match : String(value);
  });
}

/**
 * The variables every template may use.
 *
 * Built once, from the invoice and the clock. Nothing is computed inside the
 * template — a template is a sentence, not a program.
 */
export function templateVariables({ invoice, clientName, now = Date.now(), formatter }) {
  const daysLate = Math.max(0, Math.floor((now - invoice.due_on) / (24 * 60 * 60 * 1000)));

  return {
    client: clientName ?? invoice.client_name ?? 'there',
    number: invoice.number,
    amount: formatter(invoice.outstandingMinor ?? invoice.amount_minor, invoice.currency),
    total: formatter(invoice.amount_minor, invoice.currency),
    due_date: new Date(invoice.due_on).toISOString().slice(0, 10),
    issued_date: new Date(invoice.issued_on).toISOString().slice(0, 10),
    days_late: daysLate,
  };
}

/** How many days late an invoice is, floored at zero. */
export function daysLateFor(dueOn, now = Date.now()) {
  return Math.max(0, Math.floor((now - dueOn) / (24 * 60 * 60 * 1000)));
}

/** Template keys that must never be sent to a client — they are internal. */
export const INTERNAL_TEMPLATES = new Set(['late_flag']);
