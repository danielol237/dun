// The policy engine.
//
// A policy is a named, versioned set of steps. A step says: at this offset
// from this anchor, if this condition holds, do this. All of it is rows.
//
// This is the part that most "chase your invoices" products get wrong. They
// hardcode a sequence — day 3, day 7, day 14 — and then every customer wants
// something different, so the code grows a configuration file, then a
// condition language, then a mess. Starting with the data model means the
// condition language is already there and the code stays small.
//
// The engine itself is a pure function: given a policy, an invoice, and the
// history, what should happen next and when. No side effects, so it can be
// tested exhaustively and replayed.

import { addDays, dayStart } from './domain.mjs';

/**
 * Select the policy for an invoice.
 *
 * Policies carry a JSON matcher so new dimensions can be added without a
 * migration. A policy with no matcher matches everything, which makes the
 * fallback obvious and explicit.
 *
 * @returns {object|null}
 */
export function selectPolicy(db, invoice) {
  const policies = db.rows(
    'SELECT * FROM policy WHERE active = 1 ORDER BY id',
  );

  const matches = policies.filter((policy) => {
    let rules;
    try {
      rules = JSON.parse(policy.match_json || '{}');
    } catch {
      return false;
    }

    if (rules.currency && rules.currency !== invoice.currency) return false;
    if (rules.min_minor !== null && rules.min_minor !== undefined && invoice.amount_minor < rules.min_minor) return false;
    if (rules.max_minor !== null && rules.max_minor !== undefined && invoice.amount_minor > rules.max_minor) return false;

    return true;
  });

  if (matches.length === 0) return null;

  // Most specific first: a policy with constraints beats one with none.
  matches.sort((a, b) => specificity(b.match_json) - specificity(a.match_json));
  return matches[0];
}

function specificity(matchJson) {
  try {
    const rules = JSON.parse(matchJson || '{}');
    return Object.values(rules).filter((value) => value !== null && value !== undefined).length;
  } catch {
    return 0;
  }
}

export function policySteps(db, policyId) {
  return db.rows(
    'SELECT * FROM policy_step WHERE policy_id = ? ORDER BY position',
    [policyId],
  );
}

/**
 * When a step fires, as an absolute timestamp.
 *
 * The anchor is what makes this general: "7 days after due" and "7 days after
 * we last spoke" are the same mechanism with a different reference point.
 */
export function stepTime(step, { invoice, lastContactAt = null }) {
  const anchors = {
    due: invoice.due_on,
    issued: invoice.issued_on,
    last_contact: lastContactAt ?? invoice.issued_on,
  };

  const anchor = anchors[step.anchor];
  if (anchor === undefined || anchor === null) {
    throw new Error(`unknown anchor: ${step.anchor}`);
  }

  return addDays(anchor, step.offset_days);
}

/**
 * Should this step be skipped?
 *
 * `halt_if` is evaluated against a small, named set of conditions rather than
 * an expression language. A rule you can read is worth more than a rule you
 * can express, and every condition here has to be something the system can
 * actually observe.
 */
export function shouldSkip(step, context) {
  const { invoice, paidMinor, now } = context;

  switch (step.halt_if) {
    case 'paid':
      return paidMinor >= invoice.amount_minor;

    case 'void':
      return Boolean(invoice.voided_at);

    case 'never':
      return false;

    default:
      // An unknown halt condition must not silently mean "send anyway" —
      // that is how a client gets chased after they have paid.
      return true;
  }
}

/**
 * Plan the reminders for one invoice.
 *
 * Pure: returns what *should* exist, given the policy and the invoice. The
 * scheduler compares that against what does exist and reconciles. Separating
 * plan from apply is what makes the scheduler idempotent and makes "why did
 * this client get five messages" answerable.
 */
export function planInvoice(db, invoice, { now = Date.now(), lastContactAt = null } = {}) {
  const policy = selectPolicy(db, invoice);
  if (!policy) return { policy: null, plan: [] };

  const steps = policySteps(db, policy.id);
  const paidMinor = db.value(
    'SELECT COALESCE(SUM(amount_minor), 0) AS n FROM allocation WHERE invoice_id = ?',
    [invoice.id],
  );

  const plan = [];

  for (const step of steps) {
    const scheduledFor = stepTime(step, { invoice, lastContactAt });

    const skipped = shouldSkip(step, { invoice, paidMinor, now });
    const reason = skipped
      ? step.halt_if === 'paid'
        ? 'already paid'
        : step.halt_if === 'void'
          ? 'invoice voided'
          : 'unknown halt condition'
      : null;

    plan.push({
      stepId: step.id,
      position: step.position,
      action: step.action,
      channel: step.channel,
      templateKey: step.template_key,
      scheduledFor,
      due: scheduledFor <= now,
      skipped,
      skipReason: reason,
    });
  }

  return { policy, plan };
}

/**
 * The single next thing to do for an invoice.
 *
 * Returns null when there is nothing left. Used by the scheduler to decide
 * whether an invoice needs attention at all, without materialising every row.
 */
export function nextAction(db, invoice, { now = Date.now(), lastContactAt = null } = {}) {
  const { policy, plan } = planInvoice(db, invoice, { now, lastContactAt });
  if (!policy) return null;

  const pending = plan.filter((entry) => !entry.skipped && entry.scheduledFor > now);
  pending.sort((a, b) => a.scheduledFor - b.scheduledFor);

  return pending[0] ?? null;
}

/**
 * Apply a plan to the reminder table.
 *
 * Idempotent by construction: the unique index on (invoice_id, policy_step_id)
 * means re-running this cannot duplicate a reminder. Existing reminders are
 * left alone unless the plan says they should be cancelled, which is the only
 * safe direction — a reminder already sent cannot be un-sent.
 */
export function applyPlan(db, invoice, plan, { now = Date.now() } = {}) {
  const existing = new Map(
    db
      .rows('SELECT * FROM reminder WHERE invoice_id = ?', [invoice.id])
      .map((row) => [row.policy_step_id, row]),
  );

  let created = 0;
  let cancelled = 0;
  let untouched = 0;

  for (const entry of plan) {
    const current = existing.get(entry.stepId);

    if (current) {
      // Never touch a reminder that has left 'pending': it is history.
      if (current.state === 'pending' && entry.skipped) {
        db.run("UPDATE reminder SET state = 'cancelled' WHERE id = ?", [current.id]);
        cancelled += 1;
      } else {
        untouched += 1;
      }
      continue;
    }

    if (entry.skipped) continue;

    db.run(
      `INSERT INTO reminder
         (invoice_id, policy_step_id, channel, template_key, scheduled_for, state, created_at)
       VALUES (?,?,?,?,?, 'pending', ?)`,
      [invoice.id, entry.stepId, entry.channel, entry.templateKey, entry.scheduledFor, now],
    );
    created += 1;
  }

  return { created, cancelled, untouched };
}
