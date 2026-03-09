import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite';
import { Capacitor } from '@capacitor/core';

let _db = null;
const sqlite = new SQLiteConnection(CapacitorSQLite);

const SCHEMA = `
PRAGMA journal_mode=WAL;

CREATE TABLE IF NOT EXISTS transactions (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  account     TEXT NOT NULL DEFAULT '',
  from_account TEXT DEFAULT '',
  to_account  TEXT DEFAULT '',
  category    TEXT DEFAULT '',
  subcategory TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  description TEXT DEFAULT '',
  amount      REAL NOT NULL DEFAULT 0,
  inr         REAL NOT NULL DEFAULT 0,
  currency    TEXT DEFAULT 'INR',
  type        TEXT NOT NULL DEFAULT 'Expense',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS accounts (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  group_name TEXT DEFAULT '',
  icon       TEXT DEFAULT '💳',
  color      TEXT DEFAULT '#4d9fff',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS account_groups (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  type       TEXT NOT NULL DEFAULT 'Expense',
  icon       TEXT DEFAULT '📦',
  color      TEXT DEFAULT '#4d9fff',
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subcategories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id TEXT NOT NULL,
  icon        TEXT DEFAULT '',
  sort_order  INTEGER DEFAULT 0,
  FOREIGN KEY(category_id) REFERENCES categories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS budgets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  amount     REAL NOT NULL DEFAULT 0,
  period     TEXT NOT NULL DEFAULT 'monthly',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recurring (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  amount      REAL NOT NULL DEFAULT 0,
  account     TEXT DEFAULT '',
  category    TEXT DEFAULT '',
  subcategory TEXT DEFAULT '',
  type        TEXT DEFAULT 'Expense',
  frequency   TEXT DEFAULT 'monthly',
  next_date   TEXT DEFAULT '',
  note        TEXT DEFAULT '',
  active      INTEGER DEFAULT 1,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_txn_date    ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_txn_account ON transactions(account);
CREATE INDEX IF NOT EXISTS idx_txn_type    ON transactions(type);
CREATE INDEX IF NOT EXISTS idx_txn_cat     ON transactions(category);
`;

export async function initDB() {
  if (_db) return _db;
  const platform = Capacitor.getPlatform();

  if (platform === 'web') {
    const { defineCustomElements } = await import('jeep-sqlite/loader');
    defineCustomElements(window);
    await customElements.whenDefined('jeep-sqlite');
    const jeepEl = document.createElement('jeep-sqlite');
    document.body.appendChild(jeepEl);
    await customElements.whenDefined('jeep-sqlite');
    await sqlite.initWebStore();
  }

  const ret = await sqlite.checkConnectionsConsistency();
  const isConn = (await sqlite.isConnection('finman_db', false)).result;

  _db = isConn
    ? await sqlite.retrieveConnection('finman_db', false)
    : await sqlite.createConnection('finman_db', false, 'no-encryption', 1, false);

  await _db.open();

  // Run schema statements individually (jeep-sqlite limitation)
  const stmts = SCHEMA.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of stmts) {
    await _db.execute(stmt + ';');
  }

  return _db;
}

export function getDB() {
  if (!_db) throw new Error('DB not initialised — call initDB() first');
  return _db;
}
