// Templates.
//
// Messages are data. Each template has a body per tone, and the tone comes from
// the step, not from the template. That separation is what lets the same
// "late" template be gentle at day 7 and firm at day 14 without duplicating
// the copy or branching in code.
//
// Every template renders from an explicit set of variables. There is no
// arbitrary interpolation and no expression evaluation: a message can only
// contain facts the caller passed in.

/** Default template set. Overridable per policy step via `template_key`. */
export const TEMPLATES = {
  heads_up: {
    label: 'Heads up before due',
    body: 'Hi {{client}}, quick heads-up that invoice {{number}} for {{amount}} is due {{due_date}}. No rush — just so it is on your radar.',
  },
  due_today: {
    label: 'Due today',
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} is due today. Let me know if you need the details resent.',
  },
  late_gentle: {
    label: 'A week late',
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} was due {{days_late}} days ago. Have you had a chance to look at it?',
  },
  late_firm: {
    label: 'Two weeks late',
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} is now {{days_late}} days overdue. Can you confirm when it will be settled?',
  },
  late_escalate: {
    label: 'A month late',
    body: 'Hi {{client}}, invoice {{number}} for {{amount}} is {{days_late}} days overdue. I need a payment date on this one — please confirm today.',
  },
  late_flag: {
    label: 'Flagged for the owner',
    body: 'Invoice {{number}} for {{client}} ({{amount}}) is {{days_late}} days overdue. No automatic follow-up will be sent from here.',
  },
};

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

/** Template keys that must never be sent to a client — they are internal. */
export const INTERNAL_TEMPLATES = new Set(['late_flag']);
