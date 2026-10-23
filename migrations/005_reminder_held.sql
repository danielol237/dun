-- ------------------------------------------------------------ reminder 'held'
--
-- The gap this closes is the one that matters most in a chaser: money arrives,
-- and the chase continues anyway.
--
-- `onPaymentRecorded` only cancelled reminders for invoices that were fully paid.
-- A payment imported from a bank feed is deliberately NOT allocated (see
-- matcher.mjs — auto-allocating by amount is how the wrong invoice of two
-- identical ones gets marked paid), so the invoice still reads as outstanding and
-- the next tick demands money the client already sent.
--
-- 'held' is the honest middle state. It does not claim the payment settles this
-- invoice — that would be the inference the ledger design forbids. It says: there
-- is unexplained credit from this client that could cover this demand, so do not
-- send it until a person has looked. The review queue is what they look at.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt. The
-- data is copied, the indexes and the unique constraint are recreated, and the
-- foreign keys are restored — the same shape as 001, plus one state.

CREATE TABLE reminder_new (
  id             INTEGER PRIMARY KEY,
  invoice_id     INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  policy_step_id INTEGER REFERENCES policy_step(id),
  channel        TEXT NOT NULL,
  template_key   TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending'
                   CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'skipped',
                                    'cancelled', 'superseded', 'held')),
  attempted_at   INTEGER,
  sent_at        INTEGER,
  failure        TEXT,
  rendered_body  TEXT,
  -- Added by 003. A rebuild has to carry it forward: dropping it silently
  -- reverts the fix that stopped the desk claiming "due today" about a message
  -- that said "was due 6 days ago".
  rendered_template_key TEXT,
  created_at     INTEGER NOT NULL,
  UNIQUE (invoice_id, policy_step_id)
);

INSERT INTO reminder_new
  (id, invoice_id, policy_step_id, channel, template_key, scheduled_for, state,
   attempted_at, sent_at, failure, rendered_body, rendered_template_key, created_at)
SELECT id, invoice_id, policy_step_id, channel, template_key, scheduled_for, state,
       attempted_at, sent_at, failure, rendered_body, rendered_template_key, created_at
  FROM reminder;

DROP TABLE reminder;
ALTER TABLE reminder_new RENAME TO reminder;

CREATE INDEX reminder_due ON reminder (state, scheduled_for);
CREATE INDEX reminder_invoice ON reminder (invoice_id);
