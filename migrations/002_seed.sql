-- 002 — seed data.
--
-- Seeded, not hardcoded. These rows are the starting position, not the
-- behaviour: editing them changes what the product does, with no deploy. The
-- distinction matters, because "the schedule lives in a table you can change"
-- and "the schedule lives in a function" look identical in a demo and are
-- completely different products a year later.

INSERT INTO party (id, kind, display_name, created_at)
VALUES (1, 'self', 'Me', 0);

-- The default chase policy. Deliberately conservative: most freelancers
-- already feel awkward about chasing, so the tone starts warm and only
-- escalates once the invoice is genuinely late.
INSERT INTO policy (id, name, version, description, match_json, active, created_at)
VALUES (
  1,
  'standard',
  1,
  'Polite at first, firmer after the due date, escalates at 30 days late.',
  '{"currency":null,"min_minor":0,"max_minor":null}',
  1,
  0
);

INSERT INTO policy_step (policy_id, position, offset_days, anchor, action, channel, template_key, halt_if)
VALUES
  -- Three days before due: a courtesy heads-up. Most late payments are
  -- forgotten invoices, not refusals.
  (1, 1, -3, 'due', 'message', 'whatsapp', 'heads_up', 'paid'),

  -- On the due date.
  (1, 2, 0, 'due', 'message', 'whatsapp', 'due_today', 'paid'),

  -- A week late: still assuming the best.
  (1, 3, 7, 'due', 'message', 'whatsapp', 'late_gentle', 'paid'),

  -- Two weeks: name the consequence without threatening.
  (1, 4, 14, 'due', 'message', 'whatsapp', 'late_firm', 'paid'),

  -- Thirty days: a human should look at this one.
  (1, 5, 30, 'due', 'escalate', 'whatsapp', 'late_escalate', 'paid'),

  -- Forty-five days: flag for the owner. The system stops pretending it can
  -- fix this on its own.
  (1, 6, 45, 'due', 'flag', 'whatsapp', 'late_flag', 'paid');

-- A second policy for small amounts, where chasing costs more than the debt.
INSERT INTO policy (id, name, version, description, match_json, active, created_at)
VALUES (
  2,
  'small-balance',
  1,
  'Two nudges and stop. Chasing a small invoice harder costs more than it recovers.',
  '{"currency":null,"min_minor":0,"max_minor":5000000}',
  1,
  0
);

INSERT INTO policy_step (policy_id, position, offset_days, anchor, action, channel, template_key, halt_if)
VALUES
  (2, 1, 0, 'due', 'message', 'whatsapp', 'due_today', 'paid'),
  (2, 2, 14, 'due', 'message', 'whatsapp', 'late_gentle', 'paid');
