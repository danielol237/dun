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

**Messages leave through an outbox.** The scheduler renders and queues; a
separate worker drains. That keeps the scheduling transaction short and makes
retries a property of the outbox rather than of every caller.

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
scripts/
  dun.mjs           the CLI
test/
  money.test.mjs    11 tests
  domain.test.mjs   23 tests
  policy.test.mjs   22 tests
```

The policy engine is a pure function: given a policy, an invoice and the
history, it returns what should happen and when. It has no side effects, which
is why it can be tested exhaustively and replayed against old data.

---

## What is not built yet

Honest list, because a README that implies more than exists is a liability:

- **The outbox has no worker.** Messages are rendered and queued; nothing sends
  them yet. A WhatsApp adapter is the next piece, and it belongs to wabot — this
  repo deliberately does not depend on it.
- **No bank feed.** Payments are entered by hand. The `source` column exists for
  `feed:mono` / `feed:okra`, and the shape is ready, but nothing is wired.
- **No web interface.** The CLI covers every operation the UI would need.
- **No multi-tenant.** One business per database.

---

## License

MIT
