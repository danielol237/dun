-- Record what was actually said, not what was planned.
--
-- A reminder row is created from a policy step, so `template_key` holds that
-- step's intent — for example `due_today` for the step scheduled on the due
-- date. If the scheduler was down, or the invoice was backdated, that step may
-- be claimed a week later, and the message is then rendered with different
-- wording (`late_gentle`) so it does not lie about the date.
--
-- Until now only the rendered body was kept, so every surface that showed "last
-- message" read `template_key` and displayed the intent. The desk then said
-- "due today" next to a message that said "was due 6 days ago". This column is
-- the wording that was actually sent.

ALTER TABLE reminder ADD COLUMN rendered_template_key TEXT;

-- Backfill from history where a body exists but the wording was not recorded.
-- Nothing can recover the exact key for old rows, so leave them NULL and let
-- readers fall back to `template_key`.
