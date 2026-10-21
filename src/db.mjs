// Database.
//
// SQLite via sql.js (WASM), because it needs no native build and runs anywhere
// Node runs. The schema is expressed as numbered migration files, applied in
// order and recorded — the same discipline a Postgres deployment would use, so
// moving to Postgres later is a port, not a rewrite.
//
// The store exposes a small, deliberate surface. Everything that writes goes
// through a method that also writes the audit row, because a ledger whose
// history is only as good as its callers' discipline is not a ledger.

import initSqlJs from 'sql.js';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations/', import.meta.url));

let SQL = null;

async function engine() {
  if (!SQL) SQL = await initSqlJs();
  return SQL;
}

export class Db {
  #db;
  #path;

  constructor(db, path) {
    this.#db = db;
    this.#path = path;
  }

  /**
   * Open (or create) a database and bring it up to date.
   *
   * @param {string} path  file path, or ':memory:'
   */
  static async open(path = ':memory:') {
    const SQLModule = await engine();

    let db;
    if (path === ':memory:') {
      db = new SQLModule.Database();
    } else {
      try {
        db = new SQLModule.Database(new Uint8Array(await readFile(path)));
      } catch {
        await mkdir(dirname(path), { recursive: true }).catch(() => {});
        db = new SQLModule.Database();
      }
    }

    const instance = new Db(db, path);
    await instance.migrate();
    return instance;
  }

  /** Apply any migration files that have not been applied yet. */
  async migrate() {
    this.#db.run(`
      CREATE TABLE IF NOT EXISTS schema_migration (
        name       TEXT PRIMARY KEY,
        applied_at INTEGER NOT NULL
      )
    `);

    const applied = new Set(
      this.rows('SELECT name FROM schema_migration').map((row) => row.name),
    );

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      if (applied.has(file)) continue;

      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');

      // A migration is all-or-nothing: a half-applied schema is worse than an
      // unmigrated one, because the next run will skip it.
      this.#db.run('BEGIN');
      try {
        this.#db.run(sql);
        this.#db.run('INSERT INTO schema_migration (name, applied_at) VALUES (?, ?)', [file, Date.now()]);
        this.#db.run('COMMIT');
      } catch (err) {
        this.#db.run('ROLLBACK');
        throw new Error(`migration failed: ${file}: ${err.message}`);
      }
    }

    this.#db.run('PRAGMA foreign_keys = ON');
  }

  /* -------------------------------------------------------------- querying */

  /** Rows as plain objects. */
  rows(sql, params = []) {
    const stmt = this.#db.prepare(sql);
    stmt.bind(params);
    const out = [];
    while (stmt.step()) out.push(stmt.getAsObject());
    stmt.free();
    return out;
  }

  /** First row, or null. */
  row(sql, params = []) {
    return this.rows(sql, params)[0] ?? null;
  }

  /** First column of the first row, or null. */
  value(sql, params = []) {
    const result = this.row(sql, params);
    if (!result) return null;
    return Object.values(result)[0];
  }

  /**
   * Execute a statement. Returns the number of rows changed.
   *
   * Not public-by-accident: callers that write should go through a domain
   * method so the audit row and the ledger entries stay in step.
   */
  run(sql, params = []) {
    this.#db.run(sql, params);
    return this.#db.getRowsModified();
  }

  /** Last inserted rowid on this connection. */
  lastId() {
    return this.value('SELECT last_insert_rowid() AS id');
  }

  /**
   * Run a function inside a transaction.
   *
   * Nested calls reuse the outer transaction rather than failing, because the
   * domain methods compose: posting an invoice calls the ledger, and the
   * ledger does not need to know whether its caller already opened one.
   */
  transaction(fn) {
    if (this.#inTransaction) return fn();

    this.#db.run('BEGIN');
    this.#inTransaction = true;
    try {
      const result = fn();
      this.#db.run('COMMIT');
      return result;
    } catch (err) {
      this.#db.run('ROLLBACK');
      throw err;
    } finally {
      this.#inTransaction = false;
    }
  }

  #inTransaction = false;

  /* ------------------------------------------------------------ persistence */

  async flush() {
    if (this.#path === ':memory:') return;
    await mkdir(dirname(this.#path), { recursive: true }).catch(() => {});
    await writeFile(this.#path, Buffer.from(this.#db.export()));
  }

  async close() {
    await this.flush();
    this.#db.close();
  }

  export() {
    return this.#db.export();
  }
}
