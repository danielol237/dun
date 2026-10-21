-- 001 — the ledger.
--
-- Design rules, in order of how much they matter:
--
-- 1. Nothing is a mutable balance. A party's position is derived by summing
--    ledger entries. If a number can be edited in place, it can drift, and a
--    ledger that drifts is worse than no ledger.
--
-- 2. Every financial fact is a double-entry pair. An invoice creates a debit
--    to the client and a credit to revenue. A payment creates a debit to cash
--    and a credit to the client. The books balance by construction, and a bug
--    shows up as an unbalanced journal rather than as a plausible wrong number.
--
-- 3. Append-only. There is no UPDATE on ledger_entry and no DELETE. A mistake
--    is corrected by posting a reversing entry, which leaves a trail.
--
-- 4. Integers only. Money is stored in minor units (kobo/cents) as INTEGER.
--    Floating point never touches an amount.

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------- parties

CREATE TABLE party (
  id            INTEGER PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('client', 'self')),
  display_name  TEXT NOT NULL,
  -- Channel handles are how we reach them. Stored per channel, not per party,
  -- because the same client can be a phone number on WhatsApp and an email
  -- address on invoices, and either may be the one that actually gets read.
  created_at    INTEGER NOT NULL,
  archived_at   INTEGER
);

CREATE UNIQUE INDEX party_self_once ON party (kind) WHERE kind = 'self';

CREATE TABLE party_handle (
  id          INTEGER PRIMARY KEY,
  party_id    INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  channel     TEXT NOT NULL,              -- whatsapp | email | sms | phone
  value       TEXT NOT NULL,              -- normalised: E.164, lowercased email
  verified_at INTEGER,
  created_at  INTEGER NOT NULL,
  UNIQUE (channel, value)
);

CREATE INDEX party_handle_party ON party_handle (party_id);

-- ---------------------------------------------------------------- invoices

CREATE TABLE invoice (
  id             INTEGER PRIMARY KEY,
  number         TEXT NOT NULL,
  client_id      INTEGER NOT NULL REFERENCES party(id),
  currency       TEXT NOT NULL,           -- ISO 4217
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  issued_on      INTEGER NOT NULL,        -- date only, midnight UTC
  due_on         INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'part_paid', 'paid', 'void')),
  -- Where the invoice came from: 'manual', 'document', 'import:<name>'.
  -- Kept so a bad importer can be found and its rows re-derived.
  origin         TEXT NOT NULL DEFAULT 'manual',
  external_ref   TEXT,
  note           TEXT,
  created_at     INTEGER NOT NULL,
  voided_at      INTEGER
);

CREATE UNIQUE INDEX invoice_number ON invoice (number);
CREATE INDEX invoice_client ON invoice (client_id, status);
CREATE INDEX invoice_due ON invoice (due_on, status);

CREATE TABLE invoice_line (
  id           INTEGER PRIMARY KEY,
  invoice_id   INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  quantity     INTEGER NOT NULL DEFAULT 1,
  unit_minor   INTEGER NOT NULL,
  position     INTEGER NOT NULL
);

CREATE INDEX invoice_line_invoice ON invoice_line (invoice_id, position);

-- ---------------------------------------------------------------- payments

CREATE TABLE payment (
  id             INTEGER PRIMARY KEY,
  client_id      INTEGER NOT NULL REFERENCES party(id),
  currency       TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  received_on    INTEGER NOT NULL,
  -- How we learned about it. A payment nobody can trace back to a source is a
  -- payment that will be argued about.
  source         TEXT NOT NULL,           -- manual | feed:<name>
  external_ref   TEXT,
  raw_descriptor TEXT,                    -- the bank narrative, verbatim
  created_at     INTEGER NOT NULL
);

CREATE INDEX payment_client ON payment (client_id, received_on);

-- A payment may settle several invoices and an invoice may be settled by
-- several payments. That many-to-many is the whole reason this table exists:
-- modelling it as a foreign key on either side forces a lie.
CREATE TABLE allocation (
  id           INTEGER PRIMARY KEY,
  payment_id   INTEGER NOT NULL REFERENCES payment(id) ON DELETE CASCADE,
  invoice_id   INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at   INTEGER NOT NULL,
  UNIQUE (payment_id, invoice_id)
);

CREATE INDEX allocation_invoice ON allocation (invoice_id);

-- ------------------------------------------------------------- ledger entries

CREATE TABLE ledger_entry (
  id           INTEGER PRIMARY KEY,
  entry_group  TEXT NOT NULL,             -- shared by both sides of one posting
  account      TEXT NOT NULL,             -- see accounts below
  party_id     INTEGER REFERENCES party(id),
  debit_minor  INTEGER NOT NULL DEFAULT 0,
  credit_minor INTEGER NOT NULL DEFAULT 0,
  currency     TEXT NOT NULL,
  posted_at    INTEGER NOT NULL,
  -- What caused this entry. Never null: an entry with no cause is a bug.
  cause_kind   TEXT NOT NULL CHECK (cause_kind IN ('invoice', 'payment', 'reversal', 'adjustment')),
  cause_id     INTEGER,
  memo         TEXT,
  CHECK (debit_minor >= 0 AND credit_minor >= 0),
  CHECK ((debit_minor = 0) <> (credit_minor = 0))   -- exactly one side
);

CREATE INDEX ledger_account ON ledger_entry (account, posted_at);
CREATE INDEX ledger_party ON ledger_entry (party_id, posted_at);
CREATE INDEX ledger_cause ON ledger_entry (cause_kind, cause_id);
CREATE INDEX ledger_group ON ledger_entry (entry_group);

-- ------------------------------------------------------------------ policies

-- A policy is a named, versioned set of steps. Steps are rows, not code, so a
-- user can change the cadence without a deploy — and so the history of what
-- was actually sent stays attributable to the version that produced it.
CREATE TABLE policy (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  version      INTEGER NOT NULL,
  description  TEXT,
  -- Which invoices this applies to. JSON so the matching rules can grow
  -- (min amount, currency, client tag) without a migration each time.
  match_json   TEXT NOT NULL DEFAULT '{}',
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   INTEGER NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE policy_step (
  id             INTEGER PRIMARY KEY,
  policy_id      INTEGER NOT NULL REFERENCES policy(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  -- When to fire, expressed relative to the invoice. Negative = before due.
  offset_days    INTEGER NOT NULL,
  anchor         TEXT NOT NULL DEFAULT 'due' CHECK (anchor IN ('due', 'issued', 'last_contact')),
  -- What to do. 'message' sends a templated nudge; 'escalate' changes tone and
  -- may add a channel; 'flag' raises it for human attention.
  action         TEXT NOT NULL CHECK (action IN ('message', 'escalate', 'flag')),
  channel        TEXT NOT NULL DEFAULT 'whatsapp',
  template_key   TEXT NOT NULL,
  -- Stop conditions, as data. 'if_paid' is by far the most common, but a step
  -- can also stop a sequence entirely rather than just skip itself.
  halt_if       TEXT NOT NULL DEFAULT 'paid',
  UNIQUE (policy_id, position)
);

CREATE INDEX policy_step_policy ON policy_step (policy_id, position);

-- One row per client that has been assigned to a policy, with the version
-- pinned at assignment time. Re-publishing a policy does not retroactively
-- change what was already promised to a client.
CREATE TABLE policy_assignment (
  id           INTEGER PRIMARY KEY,
  policy_id    INTEGER NOT NULL REFERENCES policy(id),
  invoice_id   INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  assigned_at  INTEGER NOT NULL,
  UNIQUE (policy_id, invoice_id)
);

CREATE INDEX policy_assignment_invoice ON policy_assignment (invoice_id);

-- ---------------------------------------------------------------- reminders

-- Every send is recorded before it is attempted, so a crash mid-send cannot
-- produce a silent duplicate or a silent miss.
CREATE TABLE reminder (
  id             INTEGER PRIMARY KEY,
  invoice_id     INTEGER NOT NULL REFERENCES invoice(id) ON DELETE CASCADE,
  policy_step_id INTEGER REFERENCES policy_step(id),
  channel        TEXT NOT NULL,
  template_key   TEXT NOT NULL,
  scheduled_for  INTEGER NOT NULL,
  state          TEXT NOT NULL DEFAULT 'pending'
                   -- 'superseded' is a reminder that became moot because a
                   -- later one in the same sequence fired first. Kept as a
                   -- state rather than deleted, so the history of what was
                   -- scheduled is intact.
                   CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'skipped', 'cancelled', 'superseded')),
  attempted_at   INTEGER,
  sent_at        INTEGER,
  failure        TEXT,
  rendered_body  TEXT,
  created_at     INTEGER NOT NULL,
  -- One reminder per invoice per step. The unique index is what makes the
  -- scheduler idempotent: running it twice cannot send twice.
  UNIQUE (invoice_id, policy_step_id)
);

CREATE INDEX reminder_due ON reminder (state, scheduled_for);
CREATE INDEX reminder_invoice ON reminder (invoice_id);

-- ------------------------------------------------------------------ outbox

-- Messages leave the system through here, not directly from the scheduler.
-- A worker drains it. That keeps the scheduling transaction short and makes
-- retries a property of the outbox rather than of every caller.
CREATE TABLE outbox_message (
  id           INTEGER PRIMARY KEY,
  reminder_id  INTEGER REFERENCES reminder(id),
  channel      TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  body         TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'queued'
                 CHECK (state IN ('queued', 'claimed', 'sent', 'failed', 'dead')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  next_attempt INTEGER NOT NULL,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);

CREATE INDEX outbox_ready ON outbox_message (state, next_attempt);

-- ------------------------------------------------------------------- audit

CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  actor       TEXT NOT NULL,              -- 'system' | 'user' | 'feed:<name>'
  action      TEXT NOT NULL,
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  detail_json TEXT
);

CREATE INDEX audit_entity ON audit_log (entity, entity_id, at);
