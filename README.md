# Dun

**Invoice chasing that runs itself.**

Dun watches what you're owed and follows up on a schedule you control. It is
built for people who invoice over WhatsApp — freelancers, agencies, consultants
— where the client will never log into a portal and the only reliable channel is
the one they already answer.

No dashboard required. It runs from a command line, and everything it does is a
row in a database you own.

```
$ dun open
INV-0001     Ada Obi                 ₦450,000.00  36d late
INV-0002     Chinedu Eze           ₦1,200,000.00  6d late

$ dun tick
reconciled 2 invoices  +12 reminders  -0 cancelled
claimed 7  queued 2  skipped 0
```

---

## Why this exists

Every invoicing tool assumes the client is a rational actor with a portal login.
In most of the world they are not. They are a person on WhatsApp who said "I'll
send it this week" and then didn't.

The tools that exist either chase by email (which nobody reads) or require the
client to log in (which nobody does). The gap is not a feature gap. It is a
channel gap.

---

## The three decisions that matter

### 1. The follow-up schedule is data, not code

There is no `if (daysLate === 7)` anywhere in this codebase. A policy is a named,
versioned set of steps, and a step is a row:

```
policy: standard v1
  2026-09-12  heads_up         whatsapp   due
  2026-09-15  due_today        whatsapp   due
  2026-09-22  late_gentle      whatsapp   due
  2026-09-29  late_firm        whatsapp   due
  2026-10-15  late_escalate    whatsapp   due
  2026-10-30  late_flag        whatsapp   pending
```

Change `offset_days` from 7 to 5 and behaviour changes with no deploy and no
code review. Publish a new version and invoices already in flight keep the
version they were assigned, because a client should not be surprised by a
schedule change halfway through.

That distinction — behaviour in rows rather than in functions — is the whole
difference between a tool you can run a business on and a script.

### 2. The ledger is double-entry and append-only

Nothing in this system stores a balance. Every balance is a `SUM` over an
immutable history of paired debits and credits.

```
invoice  →  DR accounts_receivable   CR revenue
payment  →  DR cash                  CR accounts_receivable
void     →  DR revenue               CR accounts_receivable   (reversal)
```

Three consequences, all of them the point:

- The books balance by construction, not by careful coding. A bug surfaces as an
  unbalanced journal — loud and findable — rather than as a plausible wrong
  number.
- Nothing is ever updated or deleted. A mistake is corrected by posting a
  reversing entry, so the record shows both the error and the fix.
- `dun check` can prove integrity at any moment. It is the first thing a
  scheduled job should run.

Money is stored as integers in minor units. There is exactly one file that knows
how many kobo are in a naira, and nothing else divides.

### 3. It does not behave like a machine

This is the part most chase systems get wrong, and it is not a technical problem.

**One message per invoice per tick, never a backlog.** If the scheduler was down
for a week, or an invoice is backdated, only the most advanced due step is sent.
The rest are marked `superseded`. A client who receives "due today" and "30 days
overdue" in the same minute learns that the messages are automated and stops
reading all of them.

**One message per client per 20 hours.** Several invoices from one client is
ordinary. Five nudges in one tick is harassment.

**Payment stops everything immediately.** `onPaymentRecorded` cancels every
pending reminder for that client, and the claim path re-checks the balance at
send time — not just at plan time — so a payment landing between two ticks still
wins.

---

## Usage

```bash
npm install
node scripts/dun.mjs init

# people you invoice
node scripts/dun.mjs client "Ada Obi" --whatsapp 08031234567 --email ada@example.com

# what they owe
node scripts/dun.mjs invoice "Ada Obi" 450000 --due-days 14

# run the chase — put this on a cron
node scripts/dun.mjs tick

# money arrived
node scripts/dun.mjs pay "Ada Obi" 450000 --invoice INV-0001 --descriptor "TRF/ADA OBI"

# where you stand
node scripts/dun.mjs open
node scripts/dun.mjs balance
node scripts/dun.mjs check
```

Every command takes `--db`, or set `DUN_DB`. Default is `data/dun.db`.

### Put it on a schedule

```cron
0 9 * * * cd /srv/dun && node scripts/dun.mjs tick >> /var/log/dun.log 2>&1
```

One tick a day is enough. The scheduler is idempotent, so a missed run or a
double run costs nothing.

### Wire up a channel, or nothing sends

`tick` queues; it also sends, but only if a channel is configured. Without one it
says so and leaves the messages queued rather than burning attempts on a
configuration mistake.

```bash
# email — any mailbox you already pay for
export SMTP_HOST=smtp.fastmail.com
export SMTP_PORT=465
export SMTP_USER=you@yourdomain.com
export SMTP_PASS=...            # an app password, not your login
export SMTP_FROM=you@yourdomain.com
export SMTP_FROM_NAME="Your Studio"

# whatsapp — Meta's official Cloud API
export WHATSAPP_PHONE_NUMBER_ID=...
export WHATSAPP_TOKEN=...

# or anything else, over HTTP
export CHANNEL_WEBHOOK_URL=https://your-bridge.example.com/send
export CHANNEL_WEBHOOK_TOKEN=...
```

```bash
dun outbox          # what is queued, what is stuck, and why
dun send            # deliver now, without advancing the schedule
dun preview 12      # see the exact wording of message #12 before it goes
```

The webhook is the escape hatch. It receives
`{ to, body, idempotencyKey }` and any 2xx counts as delivered, so a self-hosted
bridge or a provider this repo has never heard of becomes a channel without
touching the code.

### Reading a bank statement

```bash
dun import statement.csv --source feed:gtbank
dun review              # what arrived, unallocated, with proposals
dun allocate 4 INV-0001 # confirm — the only place an allocation happens
```

Any CSV your bank exports. Columns are found by meaning, so the header order does
not matter, and dates are read day-first. Importing the same file twice changes
nothing — the bank's own reference is the identity.

What it will not do is decide which invoice a payment settles. It proposes, with
reasons, and waits for you. That is deliberate: two invoices for the same amount
make an automatic choice arbitrary, and the client who paid the *other* one gets
chased.

While a payment sits unconfirmed, any reminder it could cover is **held** rather
than sent — so connecting a statement cannot make Dun demand money that has
already arrived.

---

## Design notes

**Payments are allocated explicitly, never inferred.** Auto-matching a payment
to an invoice by amount is the classic source of quiet ledger errors: two
invoices for the same amount, and the money lands on whichever row the query
returned first. The caller says which invoice it settles. Anything unallocated
sits as a visible credit against the client, which is correct and correctable.

**A payment may settle several invoices; an invoice may be settled by several
payments.** That many-to-many is modelled as its own table, because putting a
foreign key on either side forces a lie.

**An unknown condition means silence, not action.** If a policy step carries a
`halt_if` the engine does not recognise, the step is skipped. The dangerous
failure mode is chasing someone who has already paid; the safe default is to do
nothing and let a human look.

**Reminders are never deleted.** `cancelled`, `skipped`, `superseded` and
`failed` are all states, not deletions. "Why did this client get five messages"
has to be answerable from the data.

**Messages leave through an outbox, and something actually drains it.** The
scheduler renders and queues; `dispatch` claims and sends. That keeps the
scheduling transaction short — no network call inside a write lock — and makes
retries a property of the outbox rather than of every caller.

**A retry is the same message, not a new one.** Every outbox row carries an
idempotency key derived from its reminder. A send timeout is ambiguous: the
provider may have delivered it. Without the key, the retry arrives as a second
demand for money the client already paid. With it, a provider that supports
de-duplication collapses the duplicate, and email carries it as a deterministic
`Message-ID`.

**A permanent failure stops.** Adapters classify their own failures: a 401 or a
`550 no such user` will still be that in five minutes, so retrying only fills the
log and hides the fact that nobody is being chased. A 5xx or a timeout is worth
another attempt, with backoff that grows to a ceiling and then stops.

**A crash mid-send must not strand a message.** Rows are claimed with a lease
inside a transaction, so two workers cannot both take the same row, and a process
that dies mid-send leaves a claim that expires rather than a row stuck forever in
`claimed`.

**A statement is read, never guessed at.** Bank exports are CSVs with the same
facts in a different shape, so columns are found by *meaning* — "Credit Amount"
before "Amount", because claiming the general one first flips the sign on every
payment. Dates are read day-first, because `01/06/2026` is 1 June in the market
this is built for; read month-first it becomes 6 January and quietly un-pays an
invoice. A row the parser cannot read is reported with its line number, never
coerced into a plausible number.

**Nothing is allocated automatically.** This is the mistake that ruins invoicing
tools: money arrives, find the invoice with the same amount, mark it paid. Two
invoices for ₦450,000 make that choice arbitrary and the query decides by row
order — so the client who paid the *other* one gets chased. The matcher proposes
and explains; a person confirms. Confidence requires two independent kinds of
evidence, **who** paid and **how much**; either alone is a coincidence.

**An unallocated payment pauses the chase rather than stopping it.** Because an
import deliberately leaves the payment unallocated, the invoice still reads as
outstanding — so without this, the next tick demands money already sent. A
reminder becomes `held`: not cancelled, because nobody has confirmed which invoice
the money settles, but not sent either.

---

## Architecture

```
migrations/
  001_init.sql      schema: parties, invoices, payments, ledger, policies, reminders
  002_seed.sql      the default policies, as data
src/
  money.mjs         integer minor units; the only place currency precision lives
  db.mjs            sql.js wrapper, numbered migrations, transactions
  ledger.mjs        double-entry postings, trial balance, derived balances
  domain.mjs        parties, invoices, payments, allocation, voids
  policy.mjs        policy selection, step timing, planning (pure)
  templates.mjs     message templates and rendering
  scheduler.mjs     reconcile → claim → outbox, plus invariants
  channels.mjs      delivery adapters: SMTP, WhatsApp Cloud API, webhook
  delivery.mjs      outbox claim, send, retry, dead-letter, health
  statement.mjs     CSV parsing, column detection by meaning, day-first dates
  matcher.mjs       scoring and proposals — never an allocation
  import.mjs        statement → payments, idempotent, nothing auto-credited
scripts/
  dun.mjs           the CLI
test/
  money.test.mjs    11 tests
  domain.test.mjs   23 tests
  policy.test.mjs   22 tests
  scheduler.test.mjs 24 tests
  delivery.test.mjs 14 tests
  channels.test.mjs 15 tests (real SMTP conversation, real HTTP)
  statement.test.mjs 25 tests
  matcher.test.mjs  14 tests
  import.test.mjs   12 tests
  endToEnd.test.mjs  4 tests (statement → payment → confirmed → chase stopped)
```

The policy engine is a pure function: given a policy, an invoice and the
history, it returns what should happen and when. It has no side effects, which
is why it can be tested exhaustively and replayed against old data.

---

## What is not built yet

Honest list, because a README that implies more than exists is a liability:

- **No live bank API.** Statements are imported from a CSV export, which every
  Nigerian bank produces. The `source` column is already shaped for
  `feed:mono` / `feed:okra`, and `importStatement` is the seam a poller would call
  — but nothing is wired to a provider that streams transactions yet.
- **No inbound message handling.** Dun sends. A client replying "I'll pay Friday"
  is not read, and no promise is recorded. That is the next real feature.
- **No multi-tenant.** One business per database.
- **No hosting story.** It runs from cron on a box you control. There is no
  Dockerfile and no managed deployment.

---

## License

MIT
