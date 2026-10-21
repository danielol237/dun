// The ledger.
//
// Double-entry, append-only. Two rules make this the spine of the product
// rather than a reporting table bolted on afterwards:
//
//   Every posting has exactly two sides, and they sum to zero.
//   Nothing is ever updated or deleted. A correction is a reversing entry.
//
// The consequence is that every balance in the system — what a client owes,
// what has been collected — is a SUM over an immutable history. It cannot
// disagree with the history, because it *is* the history.

import { formatAmount } from './money.mjs';

/** Chart of accounts. Kept deliberately small. */
export const ACCOUNTS = {
  RECEIVABLE: 'accounts_receivable',
  REVENUE: 'revenue',
  CASH: 'cash',
  WRITE_OFF: 'bad_debt',
};

export class Ledger {
  #db;

  constructor(db) {
    this.#db = db;
  }

  /**
   * Post a balanced pair.
   *
   * @param {object} entry
   * @param {string} entry.causeKind  'invoice' | 'payment' | 'reversal' | 'adjustment'
   * @param {number} [entry.causeId]
   * @param {number} entry.amountMinor
   * @param {string} entry.currency
   * @param {number} entry.postedAt
   * @param {string} entry.debitAccount
   * @param {string} entry.creditAccount
   * @param {number} [entry.partyId]
   * @param {string} [entry.memo]
   * @returns {{ group: string, entries: number }}
   */
  post({
    causeKind,
    causeId = null,
    amountMinor,
    currency,
    postedAt = Date.now(),
    debitAccount,
    creditAccount,
    partyId = null,
    memo = null,
  }) {
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      throw new Error('ledger amount must be a positive integer in minor units');
    }
    if (!debitAccount || !creditAccount) {
      throw new Error('both sides of a posting are required');
    }
    if (debitAccount === creditAccount) {
      throw new Error('a posting cannot debit and credit the same account');
    }

    return this.#db.transaction(() => {
      const group = `${causeKind}:${causeId ?? 'manual'}:${postedAt}:${Math.random().toString(36).slice(2, 8)}`;

      const insert = this.#db.run.bind(this.#db);

      insert(
        `INSERT INTO ledger_entry
           (entry_group, account, party_id, debit_minor, credit_minor, currency, posted_at, cause_kind, cause_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [group, debitAccount, partyId, amountMinor, 0, currency, postedAt, causeKind, causeId, memo],
      );

      insert(
        `INSERT INTO ledger_entry
           (entry_group, account, party_id, debit_minor, credit_minor, currency, posted_at, cause_kind, cause_id, memo)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [group, creditAccount, partyId, 0, amountMinor, currency, postedAt, causeKind, causeId, memo],
      );

      return { group, entries: 2 };
    });
  }

  /**
   * Every posting must balance. Used by the invariant check and by tests.
   *
   * Sums debits and credits per (currency, entry_group); any group where the
   * two differ is a bug that has already happened, not a risk.
   */
  unbalancedGroups() {
    return this.#db.rows(
      `SELECT entry_group, currency,
              SUM(debit_minor)  AS debits,
              SUM(credit_minor) AS credits
         FROM ledger_entry
        GROUP BY entry_group, currency
       HAVING SUM(debit_minor) <> SUM(credit_minor)`,
    );
  }

  /** Total debits must equal total credits, per currency. */
  trialBalance() {
    return this.#db.rows(
      `SELECT currency,
              SUM(debit_minor)  AS debits,
              SUM(credit_minor) AS credits
         FROM ledger_entry
        GROUP BY currency
        ORDER BY currency`,
    );
  }

  /**
   * What a client owes right now, per currency.
   *
   * Receivable debits minus receivable credits. Derived, never stored.
   */
  outstandingByClient(partyId) {
    return this.#db.rows(
      `SELECT currency,
              SUM(debit_minor) - SUM(credit_minor) AS balance_minor
         FROM ledger_entry
        WHERE account = ? AND party_id = ?
        GROUP BY currency
       HAVING balance_minor <> 0`,
      [ACCOUNTS.RECEIVABLE, partyId],
    );
  }

  /** Everything owed, per currency. */
  totalOutstanding() {
    return this.#db.rows(
      `SELECT currency,
              SUM(debit_minor) - SUM(credit_minor) AS balance_minor
         FROM ledger_entry
        WHERE account = ?
        GROUP BY currency
       HAVING balance_minor <> 0`,
      [ACCOUNTS.RECEIVABLE],
    );
  }

  /** Posted entries for one cause, in order. */
  entriesFor(causeKind, causeId) {
    return this.#db.rows(
      `SELECT * FROM ledger_entry
        WHERE cause_kind = ? AND cause_id = ?
        ORDER BY id`,
      [causeKind, causeId],
    );
  }

  /** A readable statement for one client. */
  statement(partyId) {
    const entries = this.#db.rows(
      `SELECT * FROM ledger_entry
        WHERE party_id = ?
        ORDER BY posted_at, id`,
      [partyId],
    );

    let running = new Map();

    return entries.map((entry) => {
      const delta = entry.debit_minor - entry.credit_minor;
      const current = (running.get(entry.currency) ?? 0) + delta;
      running.set(entry.currency, current);

      return {
        at: entry.posted_at,
        account: entry.account,
        debit: entry.debit_minor || null,
        credit: entry.credit_minor || null,
        currency: entry.currency,
        memo: entry.memo,
        balanceMinor: current,
        balance: formatAmount(current, entry.currency),
      };
    });
  }
}
