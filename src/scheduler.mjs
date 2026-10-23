// The scheduler.
//
// Runs on a clock. Each tick does three things, in this order:
//
//   1. reconcile — bring the reminder table in line with the current plan
//   2. claim     — take due reminders and render them into the outbox
//   3. report    — return what happened, for the caller to log or assert on
//
// Everything is idempotent. Running the tick twice sends nothing twice, and
// running it after a crash resumes exactly where it stopped, because the state
// that matters lives in rows rather than in memory.

import { Ledger } from './ledger.mjs';
import { planInvoice, applyPlan } from './policy.mjs';
import {
  render,
  templateVariables,
  honestTemplateKey,
  daysLateFor,
  INTERNAL_TEMPLATES,
} from './templates.mjs';
import { formatAmount } from './money.mjs';

/** How many due reminders one tick will claim. */
export const BATCH_SIZE = 200;

/**
 * Minimum gap between two messages to the same client.
 *
 * Without this, a backdated invoice or a scheduler that was down for a week
 * delivers its entire backlog in one burst — which reads as harassment and is
 * the fastest way to lose a client who was going to pay anyway.
 */
export const CLIENT_COOLDOWN_MS = 20 * 60 * 60 * 1000; // 20 hours

/**
 * Reconcile every open invoice against its policy.
 *
 * Returns counts rather than rows so a long run does not accumulate objects it
 * will never use.
 */
export function reconcile(db, { now = Date.now() } = {}) {
  const invoices = db.rows(
    `SELECT i.*, p.display_name AS client_name
       FROM invoice i JOIN party p ON p.id = i.client_id
      WHERE i.status IN ('open', 'part_paid')
        AND i.voided_at IS NULL`,
  );

  let created = 0;
  let cancelled = 0;

  for (const invoice of invoices) {
    const { plan } = planInvoice(db, invoice, { now });

    // Pin the policy version the first time an invoice is planned. Re-publishing
    // a policy must not change what a client was already promised.
    const assigned = db.row(
      'SELECT * FROM policy_assignment WHERE invoice_id = ?',
      [invoice.id],
    );

    if (!assigned && plan.length > 0) {
      const policyId = db.value(
        `SELECT policy_id FROM policy_step WHERE id = ?`,
        [plan[0].stepId],
      );
      if (policyId) {
        db.run(
          'INSERT OR IGNORE INTO policy_assignment (policy_id, invoice_id, assigned_at) VALUES (?,?,?)',
          [policyId, invoice.id, now],
        );
      }
    }

    const result = applyPlan(db, invoice, plan, { now });
    created += result.created;
    cancelled += result.cancelled;
  }

  return { invoices: invoices.length, created, cancelled };
}

/**
 * Turn due reminders into outbox messages.
 *
 * A reminder moves pending → sending → sent. The intermediate 'sending' state
 * exists so a crash between "claimed" and "rendered" is visible rather than
 * silent: a reminder stuck in 'sending' means something went wrong, and a
 * human can look.
 */
export function claimDue(db, { now = Date.now(), limit = BATCH_SIZE } = {}) {
  return db.transaction(() => {
    const candidates = db.rows(
      `SELECT r.*, i.number, i.amount_minor, i.currency, i.due_on, i.issued_on,
              i.client_id, p.display_name AS client_name,
              COALESCE(ps.position, 0) AS position
         FROM reminder r
         JOIN invoice i ON i.id = r.invoice_id
         JOIN party p ON p.id = i.client_id
         LEFT JOIN policy_step ps ON ps.id = r.policy_step_id
        WHERE r.state = 'pending'
          AND r.scheduled_for <= ?
          AND i.voided_at IS NULL
        ORDER BY r.scheduled_for, position
        LIMIT ?`,
      [now, limit],
    );

    /*
     * Collapse the backlog before sending anything.
     *
     * Two rules, both about not behaving like a machine:
     *
     * 1. Per invoice, only the most advanced due reminder is sent. The ones it
     *    superseded are marked 'superseded' — not sent, and not silently
     *    deleted. A client who receives "due today" and then "30 days overdue"
     *    in the same minute learns the messages are automated and stops reading.
     *
     * 2. Per client, one message per cooldown window. Several invoices from the
     *    same client are ordinary; five nudges in one tick is not.
     */
    const byInvoice = new Map();
    for (const reminder of candidates) {
      const current = byInvoice.get(reminder.invoice_id);
      if (!current || reminder.position > current.position) {
        byInvoice.set(reminder.invoice_id, reminder);
      }
    }

    const due = [...byInvoice.values()].sort((a, b) => a.scheduled_for - b.scheduled_for);

    let queued = 0;
    let skipped = 0;
    let superseded = 0;

    const lastSentToClient = new Map(
      db
        .rows(
          `SELECT i.client_id, MAX(r.sent_at) AS last_sent
             FROM reminder r JOIN invoice i ON i.id = r.invoice_id
            WHERE r.sent_at IS NOT NULL
            GROUP BY i.client_id`,
        )
        .map((row) => [row.client_id, row.last_sent]),
    );

    for (const reminder of due) {
      // Retire every pending reminder this one supersedes.
      const stale = db.rows(
        `SELECT r.id FROM reminder r
           LEFT JOIN policy_step ps ON ps.id = r.policy_step_id
          WHERE r.invoice_id = ? AND r.state = 'pending' AND r.id <> ?
            AND r.scheduled_for <= ?
            AND COALESCE(ps.position, 0) < ?`,
        [reminder.invoice_id, reminder.id, now, reminder.position],
      );

      for (const row of stale) {
        db.run("UPDATE reminder SET state = 'superseded' WHERE id = ?", [row.id]);
        superseded += 1;
      }

      // One message per client per cooldown window.
      const lastSent = lastSentToClient.get(reminder.client_id);
      if (lastSent && now - lastSent < CLIENT_COOLDOWN_MS) {
        skipped += 1;
        continue;
      }
      // Re-check payment at claim time, not just at plan time: a payment may
      // have landed between the reconcile and the send.
      const outstanding = db.value(
        `SELECT i.amount_minor - COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.invoice_id = i.id), 0)
           FROM invoice i WHERE i.id = ?`,
        [reminder.invoice_id],
      );

      if (outstanding <= 0) {
        db.run("UPDATE reminder SET state = 'skipped', attempted_at = ? WHERE id = ?", [now, reminder.id]);
        skipped += 1;
        continue;
      }

      const variables = templateVariables({
        invoice: { ...reminder, outstandingMinor: outstanding },
        clientName: reminder.client_name,
        now,
        formatter: formatAmount,
      });

      /*
       * A step scheduled for the due date may be claimed days later, if the
       * scheduler was down or the invoice was backdated. Sending "this is due
       * today" to a client six days overdue is a lie, and it is the kind of
       * lie that makes every later message less believable.
       *
       * So the wording follows the invoice's actual state, not the step's
       * original intent. The step still determines *that* a message is sent and
       * on which channel; only the sentence is corrected.
       */
      const daysLate = daysLateFor(reminder.due_on, now);
      const sentTemplateKey = INTERNAL_TEMPLATES.has(reminder.template_key)
        ? reminder.template_key
        : honestTemplateKey(daysLate);
      const body = render(sentTemplateKey, variables);

      db.run(
        "UPDATE reminder SET state = 'sending', attempted_at = ? WHERE id = ?",
        [now, reminder.id],
      );

      // Internal-only templates are recorded but never addressed to a client.
      if (INTERNAL_TEMPLATES.has(reminder.template_key)) {
        db.run(
          "UPDATE reminder SET state = 'sent', sent_at = ?, rendered_body = ?, rendered_template_key = ? WHERE id = ?",
          [now, body, sentTemplateKey, reminder.id],
        );
        db.run(
          `INSERT INTO audit_log (at, actor, action, entity, entity_id, detail_json)
           VALUES (?, 'system', 'reminder.internal', 'invoice', ?, ?)`,
          [now, reminder.invoice_id, JSON.stringify({ body })],
        );
        skipped += 1;
        continue;
      }

      const recipient = db.row(
        `SELECT value FROM party_handle
          WHERE party_id = ? AND channel = ?
          ORDER BY verified_at IS NULL, id
          LIMIT 1`,
        [reminder.client_id, reminder.channel],
      );

      if (!recipient) {
        db.run(
          "UPDATE reminder SET state = 'failed', failure = ? WHERE id = ?",
          ['no address on file for this channel', reminder.id],
        );
        skipped += 1;
        continue;
      }

      db.run(
        `INSERT INTO outbox_message (reminder_id, channel, recipient, body, state, attempts, next_attempt, created_at)
         VALUES (?,?,?,?, 'queued', 0, ?, ?)`,
        [reminder.id, reminder.channel, recipient.value, body, now, now],
      );

      db.run("UPDATE reminder SET state = 'sent', sent_at = ?, rendered_body = ? WHERE id = ?", [
        now,
        body,
        reminder.id,
      ]);

      // The wording that was actually used, which may differ from the step's
      // intent. Every surface that shows "last message" reads this, so the desk
      // cannot claim a message said something it did not.
      db.run('UPDATE reminder SET rendered_template_key = ? WHERE id = ?', [
        sentTemplateKey,
        reminder.id,
      ]);

      lastSentToClient.set(reminder.client_id, now);
      queued += 1;
    }

    return { claimed: candidates.length, queued, skipped, superseded };
  });
}

/** Full tick. */
export function tick(db, { now = Date.now() } = {}) {
  return db.transaction(() => {
    const reconciled = reconcile(db, { now });
    const claimed = claimDue(db, { now });
    return { ...reconciled, ...claimed };
  });
}

/**
 * Ingest a payment and close out any reminders that are now pointless.
 *
 * This is the join that makes the product feel alive: the moment money lands,
 * the chase stops. Without it, a client pays and still gets nudged, which is
 * the single fastest way to lose them.
 */
export function onPaymentRecorded(db, { clientId, currency, now = Date.now() } = {}) {
  const stale = db.rows(
    `SELECT r.id FROM reminder r
       JOIN invoice i ON i.id = r.invoice_id
      WHERE i.client_id = ?
        AND i.currency = ?
        -- 'held' counts. A reminder held because an unallocated payment might
        -- cover it is still an open chase: once the operator confirms the match,
        -- the invoice is paid and that reminder has to be retired too. Leaving it
        -- 'held' means a paid invoice still shows a paused demand, and the next
        -- tick's reconcile can pick it back up.
        AND r.state IN ('pending', 'held')
        AND i.amount_minor - COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.invoice_id = i.id), 0) <= 0`,
    [clientId, currency],
  );

  for (const reminder of stale) {
    db.run("UPDATE reminder SET state = 'cancelled' WHERE id = ?", [reminder.id]);
  }

  // ── And hold anything an unallocated payment might cover ────
  //
  // A payment imported from a bank feed is deliberately not allocated, so the
  // invoice still reads as outstanding and the next tick would demand money the
  // client has already sent. That is the single most damaging thing a chaser can
  // do, and it is not hypothetical: it is the normal path for anyone who connects
  // a statement.
  //
  // 'held' is not an allocation. It does not claim the payment settles this
  // invoice — only a person may decide that, because two invoices for the same
  // amount make the choice arbitrary. It says: there is unexplained credit from
  // this client that could cover this demand, so do not send it until someone has
  // looked at the review queue.
  //
  // The comparison is against the client's total unallocated credit rather than
  // this invoice alone, because one transfer can cover several invoices and the
  // money is not earmarked.
  const unallocated = db.value(
    `SELECT COALESCE(SUM(pay.amount_minor - COALESCE(
              (SELECT SUM(a.amount_minor) FROM allocation a WHERE a.payment_id = pay.id), 0)), 0)
       FROM payment pay
      WHERE pay.client_id = ? AND pay.currency = ?`,
    [clientId, currency],
  );

  let held = 0;
  if (unallocated > 0) {
    const coverable = db.rows(
      `SELECT r.id, i.amount_minor - COALESCE((SELECT SUM(a.amount_minor) FROM allocation a WHERE a.invoice_id = i.id), 0) AS outstanding
         FROM reminder r
         JOIN invoice i ON i.id = r.invoice_id
        WHERE i.client_id = ?
          AND i.currency = ?
          AND i.voided_at IS NULL
          AND r.state = 'pending'`,
      [clientId, currency],
    );

    for (const reminder of coverable) {
      if (reminder.outstanding <= unallocated) {
        db.run("UPDATE reminder SET state = 'held', failure = ? WHERE id = ?", [
          'unallocated payment could cover this — confirm the match',
          reminder.id,
        ]);
        held += 1;
      }
    }
  }

  return { cancelled: stale.length, held };
}

/** Ledger integrity, exposed so a scheduled job can alert on it. */
export function checkInvariants(db) {
  const ledger = new Ledger(db);

  const unbalanced = ledger.unbalancedGroups();
  const trial = ledger.trialBalance();

  const badTrial = trial.filter((row) => row.debits !== row.credits);

  return {
    ok: unbalanced.length === 0 && badTrial.length === 0,
    unbalanced,
    badTrial,
  };
}
